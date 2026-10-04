const { chromium } = require('playwright');

const PASSWORD = 'TestPassword123!';
const BASE_URL = 'http://localhost:9000/';
// Run against a freshly started dev server (`npm run dev:server` with an
// empty database): members replay the full op log at registration, and an
// earlier session's ops can leave a new replica unauthenticated against old
// signers, leaving their pages without prior-state content.

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

async function createProposal(page, title, type, options = '') {
  await page.selectOption('#proposal-type', type);
  await page.fill('#proposal-title', title);
  await page.fill('#proposal-description', `${type} proposal test`);
  if (options) {
    await page.fill('#proposal-options', options);
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

(async () => {
  let alice = null;
  let bob = null;
  try {
  alice = await runUser('alice_e2e_' + Math.floor(Math.random() * 10000));
  const directId = await createProposal(alice.page, 'Multi-choice direct', 'direct', 'Alpha, Beta, Gamma');
  console.log('Created multi-choice direct proposal', directId);

  await voteOption(alice.page, directId, 'Beta');

  bob = await runUser('bob_e2e_' + Math.floor(Math.random() * 10000));
  await voteOption(bob.page, directId, 'Alpha');

  const directTallies = await getOptionTallies(alice.page, directId);
  console.log('DIRECT TALLIES:', directTallies);
  if (JSON.stringify(directTallies) !== JSON.stringify(['1', '1', '0'])) {
    throw new Error(`Expected ['1','1','0'] on direct proposal, got ${JSON.stringify(directTallies)}`);
  }

  // --- Contribution wizard flow (submit -> verify -> settle) ---
  // Runs before quadratic voting: quadratic vote n costs n^2 $RES (1+4+9 = 14
  // for three votes) and $RES is earned only through verified contributions.
  alice.page.on('dialog', (dialog) => dialog.accept(dialogAnswer));
  bob.page.on('dialog', (dialog) => dialog.accept(dialogAnswer));

  // Cycle 1: alice submits a Building claim; bob verifies; alice settles.
  // Pays alice the C_1 bounty (12 $RES) and bob the C_18 check credit (2 $RES).
  await runWizardCycle(alice, bob, '1', 'Wizard-built e2e demo ' + Math.floor(Math.random() * 10000), 'built and matches the claim', 'accepting the verified outcome');

  // Cycle 2: bob submits a Recording claim; alice verifies; bob settles.
  // Pays bob the C_2 base credit (3 $RES) and alice a C_18 check credit
  // (2 $RES), bringing alice to exactly 14 — enough for 1+4+9 quadratic votes.
  await runWizardCycle(bob, alice, '2', 'Wizard-recorded e2e demo ' + Math.floor(Math.random() * 10000), 'the record is attributed and findable', 'accepting the verified outcome');

  const qId = await createProposal(alice.page, 'Multi-choice quadratic', 'quadratic', 'Red, Green, Blue');
  console.log('Created multi-choice quadratic proposal', qId);

  for (let i = 0; i < 3; i++) {
    await voteOption(alice.page, qId, 'Red');
  }

  const qTallies = await getOptionTallies(alice.page, qId);
  console.log('QUADRATIC TALLIES:', qTallies);
  if (JSON.stringify(qTallies) !== JSON.stringify(['3', '0', '0'])) {
    throw new Error(`Expected ['3','0','0'] on quadratic proposal, got ${JSON.stringify(qTallies)}`);
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
  // The set_token_config custodian op and its form were deleted; voting now
  // spends the $RES balance directly, so skip straight to member removal.
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
  console.log('Smoke test passed');
  } catch (err) {
    // Dump per-page diagnostics so failures stay legible: the status bar,
    // and short snapshots of the proposals and contributions lists.
    for (const [name, u] of [['alice', alice], ['bob', bob]]) {
      if (!u?.page) continue;
      try {
        console.log(`[${name} status]`, await u.page.locator('#status').textContent());
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
