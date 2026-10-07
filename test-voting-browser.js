const { chromium } = require('playwright');

const PASSWORD = 'TestPassword123!';
const BASE_URL = 'http://localhost:9000/';
// Run against a freshly started dev server (`npm run dev:server` with an
// empty database — e.g. WAVEDB_PATH=/tmp/dao-p2-e2e): members replay the full
// op log at registration, and an earlier session's ops can leave a new
// replica unauthenticated against old signers, leaving their pages without
// prior-state content. The phase-2 round extension below (audit → reckon →
// complete, then a salient quadratic proposal on the published round) also
// REQUIRES the fresh DB: the spine publishes round 1's accepted contributions
// and re-running on a used database would find no open round to close.

async function runUser(username, headless = true) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(`[${username}]`, msg.text()));
  page.on('pageerror', (err) => console.log(`[${username} pageerror]`, err.message));

  await page.goto(BASE_URL);
  await page.waitForSelector('#register-username', { timeout: 30000 });

  await page.fill('#register-username', username);
  await page.fill('#register-password', PASSWORD);
  await page.fill('#register-password-confirm', PASSWORD);
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('#dashboard:not(.hidden)', { timeout: 30000 });

  return { browser, page };
}

async function createProposal(page, title, type, options = '', salientDims = []) {
  await page.selectOption('#proposal-type', type);
  await page.fill('#proposal-title', title);
  await page.fill('#proposal-description', `${type} proposal test`);
  if (options) {
    await page.fill('#proposal-options', options);
  }
  for (const dim of salientDims) {
    await page.check(`.salient-dim[value="${dim}"]`);
  }
  await page.click('#proposal-form button[type="submit"]');
  const card = page.locator(`.proposal-card:has(.proposal-card__title:text-is("${title}"))`).first();
  await card.waitFor({ state: 'visible' });
  return card.locator('.proposal-card__id').first().textContent();
}

async function getOptionTallies(page, proposalId) {
  const card = page.locator(`.proposal-card:has(.proposal-card__id:text-is("${proposalId}"))`).first();
  return card.locator('.vote-stat__value').allTextContents();
}

async function voteOption(page, proposalId, optionLabel) {
  const card = page.locator(`.proposal-card:has(.proposal-card__id:text-is("${proposalId}"))`).first();
  const btn = card.locator(`.vote-option:has-text("${optionLabel}")`).first();
  await btn.waitFor({ state: 'visible' });
  await btn.click({ force: true });
  await page.waitForTimeout(1500);
}

// Answer for the wizard's confirm()/prompt() dialogs. Both browser contexts
// share it because the flows run strictly sequentially; a single handler per
// page (registered once) avoids double-accepting the same dialog.
let dialogAnswer = '';

// One full wizard cycle: submit a contribution, verify it, settle it.
async function runWizardCycle(submitter, verifier, dimValue, summary, verifyReason, settleNote) {
  dialogAnswer = verifyReason;
  await submitter.page.check(`#contribution-step-1 input[name="contrib-dim"][value="${dimValue}"]`);
  await submitter.page.fill('#contribution-summary', summary);
  await submitter.page.fill('#contribution-evidence-text', 'https://example.com/evidence/e2e');
  await submitter.page.click('#contribution-form button[type="submit"]');
  const card = submitter.page
    .locator(`.contribution-card:has-text("${summary}")`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 30000 });
  console.log('Submitted contribution via wizard flow:', summary);

  const verifyBtn = verifier.page
    .locator(`.contribution-card:has-text("${summary}") .verify-contribution`)
    .first();
  await verifyBtn.waitFor({ state: 'visible', timeout: 30000 });

  const settleBtn = submitter.page
    .locator(`.contribution-card:has-text("${summary}") .settle-contribution`)
    .first();

  // The verify button opens confirm() then prompt() — dialogs must be armed
  // before the click or Playwright auto-dismisses them (which would record a
  // rejection). The demo clock re-renders the list every second (replacing
  // every rendered node), which can swallow mouse clicks in flight, so click
  // from inside the page (always the current node) and retry until the
  // verifier's op has been applied — the settle step only becomes actionable
  // once it is.
  const clickInCard = (page, cardText, selector) =>
    page.evaluate(({ cardText, selector }) => {
      const el = [...document.querySelectorAll('.contribution-card')]
        .find((c) => c.textContent.includes(cardText));
      const btn = el && el.querySelector(selector);
      if (btn && !btn.disabled) btn.click();
      return !!btn && !btn.disabled;
    }, { cardText, selector });

  let settleReady = false;
  for (let attempt = 0; !settleReady && attempt < 15; attempt++) {
    dialogAnswer = verifyReason;
    await clickInCard(verifier.page, summary, '.verify-contribution');
    settleReady = await settleBtn
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!settleReady) {
    const statusBar = await verifier.page.locator('#status').textContent();
    throw new Error(`Settle step never became actionable. Status bar: ${statusBar || '(empty)'}`);
  }

  // The settle step is only actionable once the verifier's op has been
  // applied (requirement + step register), so its appearance proves the
  // verify round-trip succeeded.
  dialogAnswer = settleNote;

  // The demo clock re-renders the whole list every second and can swallow a
  // click in flight; click from inside the page and retry until the pill
  // flips to 'accepted'.
  let settled = false;
  for (let attempt = 0; !settled && attempt < 15; attempt++) {
    await clickInCard(submitter.page, summary, '.settle-contribution');
    settled = await card
      .locator('.contribution-pill:text-is("accepted")')
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!settled) {
    const statusBar = await submitter.page.locator('#status').textContent();
    throw new Error(`Status pill never flipped to accepted. Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('CONTRIBUTION STATUS PILL: accepted');
}

// One round-spine step: click the persistent stage-gated round-panel button
// (armed dialogs first) and retry until the NEXT stage's button becomes
// visible — its appearance proves the op was executed, mirroring how the
// wizard loop waits for the settle button. The spine ops need no extra UI
// data besides the dialogs: complete collects the round's accepted entries
// (contribution id, submitter, dims) itself. Spine policies are
// 'role:member OR role:custodian', so a plain member can close the round.
async function runRoundSpineStep(actor, buttonId, nextButtonId, note) {
  if (note !== null) {
    dialogAnswer = note;
  }
  let ready = false;
  for (let attempt = 0; !ready && attempt < 15; attempt++) {
    if (await actor.page.locator(`#${buttonId}`).isVisible().catch(() => false)) {
      await actor.page.locator(`#${buttonId}`).click({ force: true }).catch(() => {});
      await actor.page.waitForTimeout(1500);
    }
    ready = await actor.page
      .locator(`#${nextButtonId}:not(.hidden)`)
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!ready) {
    const statusBar = await actor.page.locator('#status').textContent();
    throw new Error(`Round spine stuck at ${buttonId}; ${nextButtonId} never became visible. Status bar: ${statusBar || '(empty)'}`);
  }
}

(async () => {
  let alice = null;
  let bob = null;
  try {
  const aliceName = 'alice_e2e_' + Math.floor(Math.random() * 10000);
  const bobName = 'bob_e2e_' + Math.floor(Math.random() * 10000);
  alice = await runUser(aliceName);
  const directId = await createProposal(alice.page, 'Multi-choice direct', 'direct', 'Alpha, Beta, Gamma');
  console.log('Created multi-choice direct proposal', directId);

  await voteOption(alice.page, directId, 'Beta');

  bob = await runUser(bobName);
  await voteOption(bob.page, directId, 'Alpha');

  const directTallies = await getOptionTallies(alice.page, directId);
  console.log('DIRECT TALLIES:', directTallies);
  if (JSON.stringify(directTallies) !== JSON.stringify(['1', '1', '0'])) {
    throw new Error(`Expected ['1','1','0'] on direct proposal, got ${JSON.stringify(directTallies)}`);
  }

  // --- Contribution wizard flow (submit -> verify -> settle) ---
  // Runs before quadratic voting: the settled contributions fund the round's
  // $RES bounties and — since phase 2 — the C-dimension tallies that set the
  // salient quadratic vote balance ($RES itself no longer gates votes).
  alice.page.on('dialog', (dialog) => dialog.accept(dialogAnswer));
  bob.page.on('dialog', (dialog) => dialog.accept(dialogAnswer));

  // Cycle 1: alice submits a Building claim; bob verifies; alice settles.
  // Pays alice the C_1 bounty (12 $RES) and gives her a C_1 tally of 1.
  await runWizardCycle(alice, bob, '1', 'Wizard-built e2e demo ' + Math.floor(Math.random() * 10000), 'built and matches the claim', 'accepting the verified outcome');

  // Cycle 2: bob submits a Recording claim; alice verifies; bob settles.
  // Pays bob the C_2 base credit (3 $RES) and alice a C_18 check credit
  // (2 $RES); bob's settle gives him a C_2 tally of 1.
  await runWizardCycle(bob, alice, '2', 'Wizard-recorded e2e demo ' + Math.floor(Math.random() * 10000), 'the record is attributed and findable', 'accepting the verified outcome');

  // --- Round spine close (phase 2) ---
  // alice (any member — spine policies are 'role:member OR role:custodian')
  // audits the round fair against the registered v1 calibration, reckons,
  // then completes: complete_round aggregates BOTH accepted contributions
  // (alice C_1 1, bob C_2 1) into cumulative RCT (alpha defaults to 1, so
  // alice publishes 1 RCT) and advances to Round 2.
  console.log('Closing round 1 through the spine (audit → reckon → complete)');
  await runRoundSpineStep(alice, 'audit-round-btn', 'reckon-round-btn', 'phase-2 e2e audit note: fair against v1');
  console.log('ROUND STAGE: audited');
  await runRoundSpineStep(alice, 'reckon-round-btn', 'complete-round-btn', 'phase-2 e2e reckon note: records settled');
  console.log('ROUND STAGE: reckoned');
  dialogAnswer = '';
  // The complete button collects the accepted entries itself; success is
  // proven by the stepper label advancing to Round 2.
  let round2 = false;
  for (let attempt = 0; !round2 && attempt < 15; attempt++) {
    if (await alice.page.locator('#complete-round-btn').isVisible().catch(() => false)) {
      await alice.page.locator('#complete-round-btn').click({ force: true }).catch(() => {});
    }
    round2 = await alice.page
      .locator('.round-label', { hasText: 'Round 2' })
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!round2) {
    const statusBar = await alice.page.locator('#status').textContent();
    throw new Error(`Round never advanced to 2 after complete. Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('ROUND PUBLISHED: round 2 is open');

  // --- Quadratic voting (base-only funding since phase 2) ---
  // Without salient dims a quadratic proposal grants the base balance (3), so
  // alice's first vote (cumulative cost 1) counts and her second (cumulative
  // 1+4=5 > 3) is rejected by the server — surfaced as 'Vote error' in the
  // status bar.
  const qId = await createProposal(alice.page, 'Multi-choice quadratic', 'quadratic', 'Red, Green, Blue');
  console.log('Created multi-choice quadratic proposal', qId);

  // Retry-until-counted: the demo clock can swallow clicks.
  let firstLanded = false;
  for (let attempt = 0; !firstLanded && attempt < 15; attempt++) {
    await voteOption(alice.page, qId, 'Red');
    const tallies = await getOptionTallies(alice.page, qId);
    firstLanded = tallies[0] === '1';
  }
  dialogAnswer = '';
  let baseVoteRejected = false;
  for (let attempt = 0; !baseVoteRejected && attempt < 15; attempt++) {
    await voteOption(alice.page, qId, 'Red');
    baseVoteRejected = (await alice.page.locator('#status').textContent()).includes('Vote error');
  }
  const qTallies = await getOptionTallies(alice.page, qId);
  console.log('QUADRATIC TALLIES:', qTallies);
  if (!firstLanded) {
    throw new Error(`First base-only quadratic vote never landed; tallies ${JSON.stringify(qTallies)}`);
  }
  if (!baseVoteRejected) {
    throw new Error(`Second base-only quadratic vote (cumulative 1+4=5 > base 3) was not rejected. Tallies: ${JSON.stringify(qTallies)}`);
  }
  if (JSON.stringify(qTallies) !== JSON.stringify(['1', '0', '0'])) {
    throw new Error(`Expected ['1','0','0'] on base-only quadratic proposal, got ${JSON.stringify(qTallies)}`);
  }

  // --- Custodian election flow ---
  // carol and dave register; their registrations broadcast to alice/bob pages.
  const carol = await runUser('carol_e2e_' + Math.floor(Math.random() * 10000));
  await carol.browser.close();
  const dave = await runUser('dave_e2e_' + Math.floor(Math.random() * 10000));
  await dave.browser.close();

  // Start the election from alice's page.
  await alice.page.click('#start-election');
  await alice.page.waitForTimeout(1500);

  // Alice and bob each cast a ballot (checkboxes scoped to their election card).
  await alice.page.locator('.ballot-option').first().waitFor({ state: 'visible', timeout: 30000 });
  const checkboxes = await alice.page.$$('.ballot-option');
  await checkboxes[0].click(); // alice picks first candidate
  await alice.page.click('#election-area button.button--primary');
  await alice.page.waitForTimeout(1500);

  await bob.page.locator('.ballot-option').first().waitFor({ state: 'visible', timeout: 30000 });
  const bobCheckboxes = await bob.page.$$('.ballot-option');
  await bobCheckboxes[0].click();
  await bob.page.click('#election-area button.button--primary');
  await bob.page.waitForTimeout(1500);

  // Wait for expiry (60s), then finalize.
  await alice.page.waitForTimeout(62000);
  await alice.page.click('.finalize-election');
  await alice.page.waitForTimeout(2000);

  // Custodian controls appear for alice (a winner with the most picks).
  // The set_token_config custodian op and its form were deleted; since
  // phase 2, votes are gated by the salient-derived balance (not $RES), so
  // skip straight to member removal.
  const removeBtn = alice.page.locator('.remove-member').first();
  try {
    await removeBtn.waitFor({ state: 'visible', timeout: 30000 });
  } catch (err) {
    console.log('alice is not a custodian; skipping member removal');
  }
  if (await removeBtn.count()) {
    await removeBtn.click({ force: true });
    await alice.page.waitForTimeout(1500);
  }

  console.log('Custodian election smoke flow completed');

  // --- Phase-2 round extension: salient quadratic on the published round ---
  // Round 2 is open after the spine. alice publishes her C_1 contribution's
  // tally (1; alpha defaults to 1) into the proposal's salient mask, so her
  // vote balance is base 3 + 1x1 = 4: the first vote (cumulative 1) counts
  // and the second (cumulative 1+4=5 > 4) is rejected.
  const sId = await createProposal(alice.page, 'Salient quadratic round 2', 'quadratic', 'One, Two, Three', ['1']);
  console.log('Created C_1-salient quadratic proposal on round 2', sId);

  let salientFirstLanded = false;
  for (let attempt = 0; !salientFirstLanded && attempt < 15; attempt++) {
    await voteOption(alice.page, sId, 'One');
    const tallies = await getOptionTallies(alice.page, sId);
    salientFirstLanded = tallies[0] === '1';
  }
  let salientVoteRejected = false;
  for (let attempt = 0; !salientVoteRejected && attempt < 15; attempt++) {
    await voteOption(alice.page, sId, 'One');
    salientVoteRejected = (await alice.page.locator('#status').textContent()).includes('Vote error');
  }
  const sTallies = await getOptionTallies(alice.page, sId);
  console.log('SALIENT QUADRATIC TALLIES:', sTallies);
  if (!salientFirstLanded) {
    throw new Error(`First salient quadratic vote never landed; tallies ${JSON.stringify(sTallies)}`);
  }
  if (!salientVoteRejected) {
    throw new Error(`Second salient quadratic vote (cumulative 1+4=5 > balance 4) was not rejected. Tallies: ${JSON.stringify(sTallies)}`);
  }
  if (JSON.stringify(sTallies) !== JSON.stringify(['1', '0', '0'])) {
    throw new Error(`Expected ['1','0','0'] on salient quadratic proposal, got ${JSON.stringify(sTallies)}`);
  }

  // Round panel advanced with the spine and the published RCT badge shows.
  const roundLabel = await alice.page.locator('.round-label').textContent();
  console.log('ROUND PANEL:', roundLabel);
  if (!roundLabel.startsWith('Round 2')) {
    throw new Error(`Expected round panel to show 'Round 2 ...', got '${roundLabel}'`);
  }
  const rctBadge = await alice.page.locator(`[data-member-rct="${aliceName}"]`).textContent();
  console.log('ALICE RCT BADGE:', rctBadge);
  if (rctBadge.trim() !== '1 RCT') {
    throw new Error(`Expected alice's RCT badge to read '1 RCT', got '${rctBadge.trim()}'`);
  }

  console.log('Smoke test passed');
  } catch (err) {
    // Dump per-page diagnostics so failures stay legible: the status bar,
    // and short snapshots of the proposals and contributions lists.
    for (const [name, u] of [['alice', alice], ['bob', bob]]) {
      if (!u?.page) continue;
      try {
        console.log(`[${name} status]`, await u.page.locator('#status').textContent());
        console.log(`[${name} round]`, await u.page.locator('.round-label').textContent());
        console.log(`[${name} proposals]`, (await u.page.locator('#proposals').innerHTML()).slice(0, 400));
        console.log(`[${name} contributions]`, (await u.page.locator('#contributions-list').innerHTML()).slice(0, 400));
      } catch (e) {
        console.log(`[${name} debug]`, e.message);
      }
    }
    throw err;
  } finally {
    for (const u of [alice, bob]) {
      if (u) { try { await u.browser.close(); } catch (err) { /* already closed */ } }
    }
  }
})();
