const { chromium } = require('playwright');

const PASSWORD = 'TestPassword123!';
const BASE_URL = 'http://localhost:9000/';

// SPA navigation between feature routes — never page.goto: a reload would
// drop the in-memory wallet state the flows rely on. Auth redirects every
// route back to the feed when unauthenticated, so this only ever runs on a
// logged-in page.
const nav = (page, href) => page.click(`header nav a[href="${href}"]`);
// Run against a freshly started dev server (`npm run dev:server` with an
// empty database — e.g. WAVEDB_PATH=/tmp/dao-p3-e2e): members replay the full
// op log at registration, and an earlier session's ops can leave a new
// replica unauthenticated against old signers, leaving their pages without
// prior-state content. The phase-2 round extension below (audit → reckon →
// complete, then a salient quadratic proposal on the published round) also
// REQUIRES the fresh DB: the spine publishes round 1's accepted contributions
// and re-running on a used database would find no open round to close.
//
// The custodian-election section below is ALSO the regression assert for the
// client-wasm wire-drift fix (issue #37): election finalize makes the server
// broadcast a server-signed sync_roles op, which a drifted vendored binary
// cannot deserialize ('Failed to apply update: Operation.deserialize failed')
// so every later client-signed op dies key_stale on the server. With the
// re-synced wasm the grant must APPLY (custodians list renders) and alice's
// post-election ops must be accepted — asserted below, plus a second election
// cycle to prove the key-version catch-up repeats.

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

  // The feed is the landing page now — route to the proposal page up front.
  await nav(page, '/proposals');

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

// The demo clock re-renders the list every second (replacing every rendered
// node), which can swallow mouse clicks in flight, so click from inside the
// page (always the current node) — callers retry until the op's UI effect
// appears.
const clickInCard = (page, cardText, selector) =>
  page.evaluate(({ cardText, selector }) => {
    const el = [...document.querySelectorAll('.contribution-card')]
      .find((c) => c.textContent.includes(cardText));
    const btn = el && el.querySelector(selector);
    if (btn && !btn.disabled) btn.click();
    return !!btn && !btn.disabled;
  }, { cardText, selector });

// Drive an in-place wizard flow to completion. `choiceValue` selects the
// flow's FIRST-STEP radio (verify decision / audit fairness); `textValue`
// fills the first text step encountered. Retries through the flow's own
// draft-resume path: a failed submit keeps the draft (and the open flow),
// so a later attempt resumes at the restored step with everything filled.
async function completeFlow(page, flowId, { choiceValue = null, textValue = '' } = {}) {
  // Return value intentionally ignored by callers: the UI effect (settle
  // button, pill flip, next spine button) is the assertion.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const flow = page.locator(`.wizard-flow[data-flow-id="${flowId}"]`);
      if (!(await flow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) return false;
      // Drive only from the CURRENT step: a flow resumed past the choice step
      // renders no radios at all — ':checked' alone can't tell "not checked"
      // from "already committed", so require the control to exist.
      const choiceControl = choiceValue !== null ? flow.locator(`.wizard-option[value="${choiceValue}"]`) : null;
      const atChoiceStep = choiceControl && (await choiceControl.count()) > 0;
      const textareas = flow.locator('textarea');
      if (atChoiceStep) {
        await choiceControl.check();
        await flow.locator('.wizard-next').click();
        await flow.locator('textarea').waitFor({ state: 'visible', timeout: 3000 });
      }
      if ((await textareas.count()) > 0) {
        // Fill only when empty: the on-step answer is uncommitted by
        // construction (a commit moves the flow past the step), so a filled
        // textarea here means a prior attempt's NEXT click was swallowed mid-
        // drive (or a backward draft resume) — clicking Next again is the
        // recovery, not a double-advance.
        if (!(await textareas.first().inputValue())) {
          await textareas.first().fill(textValue);
        }
        await flow.locator('.wizard-next').click();
        await flow.locator('.wizard-submit').waitFor({ state: 'visible', timeout: 3000 });
      }
      if (await flow.locator('.wizard-submit').count()) {
        if (!(await flow.locator('.wizard-submit').isDisabled())) {
          await flow.locator('.wizard-submit').click();
          return true;
        }
        await page.waitForTimeout(1000); // submitting — retry window
        continue;
      }
      await page.waitForTimeout(1000); // mid-drive race — the outer loop re-enters
    } catch (err) {
      // A transient race inside one attempt must not escape into the caller's
      // UI-effect retry loop.
      await page.waitForTimeout(1000);
    }
  }
  return false;
}

// Wizard submit only: fills the contribution form on the submitter's page
// and waits for the card. Returns the card locator (scoped to the summary).
async function submitContribution(submitter, dimValue, summary) {
  await submitter.page.check(`#contribution-step-1 input[name="contrib-dim"][value="${dimValue}"]`);
  await submitter.page.fill('#contribution-summary', summary);
  await submitter.page.fill('#contribution-evidence-text', 'https://example.com/evidence/e2e');
  await submitter.page.click('#contribution-form button[type="submit"]');
  const card = submitter.page
    .locator(`.contribution-card:has-text("${summary}")`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 30000 });
  console.log('Submitted contribution via wizard flow:', summary);
  return card;
}

// One full wizard cycle (single-verifier schema): submit, verify, settle.
async function runWizardCycle(submitter, verifier, dimValue, summary, verifyReason, settleNote) {
  const card = await submitContribution(submitter, dimValue, summary);

  const verifyBtn = verifier.page
    .locator(`.contribution-card:has-text("${summary}") .verify-contribution`)
    .first();
  await verifyBtn.waitFor({ state: 'visible', timeout: 30000 });

  const settleBtn = submitter.page
    .locator(`.contribution-card:has-text("${summary}") .settle-contribution`)
    .first();

  // Retry until the settle step becomes actionable: each attempt re-clicks
  // the verify button and drives the in-place wizard (harm choice → written
  // reason → review submit) to completion.
  let settleReady = false;
  for (let attempt = 0; !settleReady && attempt < 15; attempt++) {
    await clickInCard(verifier.page, summary, '.verify-contribution');
    await completeFlow(verifier.page, 'verify', { choiceValue: 'yes', textValue: verifyReason });
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

  // The demo clock re-renders the whole list every second and can swallow a
  // click in flight; click from inside the page, drive the settle wizard
  // (note → review submit), and retry until the pill flips to 'accepted'.
  let settled = false;
  for (let attempt = 0; !settled && attempt < 15; attempt++) {
    await clickInCard(submitter.page, summary, '.settle-contribution');
    await completeFlow(submitter.page, 'settle', { textValue: settleNote });
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

// Phase-3 two-verifier cycle (schema v2: C_1's verify is all-parties, count
// 2): submit, verify from v1 (the stepper chip must show (1/2)), verify from
// v2 (whose button reads 'Verify (2nd)'), settle. The settle step only
// becomes actionable once BOTH verifications have applied.
//
// v1's verify wizard is driven with a harm verdict (`harmChoice`, the FIRST
// decision radio's value — 'yes' by default): 'yes-harm' records a 'reduced'
// verdict on the FIRST check, and the completing check automatically carries
// that verdict forward as the payload's priorHarm (the UI reads it out of
// its mirror), so strongest-wins keeps 'reduced' effective at settle —
// asserted via the card's harm receipt.
async function runTwoVerifierCycle(submitter, v1, v2, dimValue, summary, verifyReason, settleNote, harmChoice = 'yes') {
  const card = await submitContribution(submitter, dimValue, summary);

  let halfDone = false;
  for (let attempt = 0; !halfDone && attempt < 15; attempt++) {
    await clickInCard(v1.page, summary, '.verify-contribution');
    await completeFlow(v1.page, 'verify', { choiceValue: harmChoice, textValue: verifyReason });
    halfDone = await v1.page
      .locator(`.contribution-card:has-text("${summary}") .contribution-step--current:has-text("(1/2)")`)
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!halfDone) {
    const statusBar = await v1.page.locator('#status').textContent();
    throw new Error(`Verify quorum never showed (1/2). Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('VERIFY PROGRESS: (1/2) after the first verifier');

  // The second check's button is labelled 'Verify (2nd)' — the mirror's
  // verifiedBy copy proves the first check replicated to this page.
  const secondBtn = v2.page
    .locator(`.contribution-card:has-text("${summary}") .verify-contribution:has-text("Verify (2nd)")`)
    .first();
  let secondVisible = false;
  for (let attempt = 0; !secondVisible && attempt < 15; attempt++) {
    secondVisible = await secondBtn
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!secondVisible) {
    const statusBar = await v2.page.locator('#status').textContent();
    throw new Error(`'Verify (2nd)' button never appeared for the second verifier. Status bar: ${statusBar || '(empty)'}`);
  }

  const settleBtn = submitter.page
    .locator(`.contribution-card:has-text("${summary}") .settle-contribution`)
    .first();
  let settleReady = false;
  for (let attempt = 0; !settleReady && attempt < 15; attempt++) {
    await clickInCard(v2.page, summary, '.verify-contribution');
    // the completing check rides 'yes' — it carries the prior verdict
    // (priorHarm from the mirror), so no fresh harm choice is made
    await completeFlow(v2.page, 'verify', { choiceValue: 'yes', textValue: verifyReason });
    settleReady = await settleBtn
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!settleReady) {
    const statusBar = await v2.page.locator('#status').textContent();
    throw new Error(`Settle step never became actionable after the second verify. Status bar: ${statusBar || '(empty)'}`);
  }

  let settled = false;
  for (let attempt = 0; !settled && attempt < 15; attempt++) {
    await clickInCard(submitter.page, summary, '.settle-contribution');
    await completeFlow(submitter.page, 'settle', { textValue: settleNote });
    settled = await card
      .locator('.contribution-pill:text-is("accepted")')
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!settled) {
    const statusBar = await submitter.page.locator('#status').textContent();
    throw new Error(`Status pill never flipped to accepted. Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('CONTRIBUTION STATUS PILL: accepted (two verifiers)');

  // A harm verdict rides the replicate verify ops, so the submitter's settled
  // card must render the adjusted receipt once it is accepted ('reduced' →
  // 'accepted — bounty 12 → 6 (harm reduced)' for a C_1 dims '1': 1).
  if (harmChoice !== 'yes') {
    const receipt = card.locator('.contribution-card__harm');
    await receipt.waitFor({ state: 'visible', timeout: 10000 });
    const receiptText = (await receipt.textContent()).trim();
    console.log('HARM RECEIPT:', receiptText);
    if (!receiptText.includes('(harm reduced)')) {
      throw new Error(`Expected the settled card's harm receipt, got '${receiptText}'`);
    }
  }
}

// Phase-3 appeal flow: submit → a REJECTING verification (the verify
// wizard's decision radio answered 'no') → the submitter appeals (status
// pill 'appealed') → a fresh member re-verifies accepted → settle. The
// appealed pill must be visible between the appeal and the settle.
async function runAppealFlow(submitter, rejecter, reVerifier, dimValue, summary, rejectReason, appealReason, reVerifyReason, settleNote) {
  const card = await submitContribution(submitter, dimValue, summary);

  let rejected = false;
  for (let attempt = 0; !rejected && attempt < 15; attempt++) {
    // the decision radio's 'no' records the rejection with the written reason
    await clickInCard(rejecter.page, summary, '.verify-contribution');
    await completeFlow(rejecter.page, 'verify', { choiceValue: 'no', textValue: rejectReason });
    rejected = await submitter.page
      .locator(`.contribution-card:has-text("${summary}") .contribution-pill:text-is("rejected")`)
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!rejected) {
    const statusBar = await rejecter.page.locator('#status').textContent();
    throw new Error(`Verification never recorded as rejected. Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('CONTRIBUTION STATUS PILL: rejected');

  let appealed = false;
  for (let attempt = 0; !appealed && attempt < 15; attempt++) {
    await clickInCard(submitter.page, summary, '.appeal-contribution');
    await completeFlow(submitter.page, 'appeal', { textValue: appealReason });
    appealed = await submitter.page
      .locator(`.contribution-card:has-text("${summary}") .contribution-pill:text-is("appealed")`)
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!appealed) {
    const statusBar = await submitter.page.locator('#status').textContent();
    throw new Error(`Appealed pill never appeared. Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('APPEALED PILL: visible before settle');

  // The re-verifier's button title carries their live accuracy stat ("Your
  // checks: X (Y upheld)") — fed by earlier settles' attested verifier lists.
  const reVerifyBtn = reVerifier.page
    .locator(`.contribution-card:has-text("${summary}") .verify-contribution`)
    .first();
  await reVerifyBtn.waitFor({ state: 'visible', timeout: 30000 });
  const btnTitle = await reVerifyBtn.getAttribute('title');
  console.log('VERIFY BUTTON TITLE:', btnTitle);
  if (!btnTitle || !btnTitle.includes('upheld')) {
    throw new Error(`Verify button title should include the accuracy stat, got '${btnTitle}'`);
  }

  const settleBtn = submitter.page
    .locator(`.contribution-card:has-text("${summary}") .settle-contribution`)
    .first();
  let settleReady = false;
  for (let attempt = 0; !settleReady && attempt < 15; attempt++) {
    await clickInCard(reVerifier.page, summary, '.verify-contribution');
    await completeFlow(reVerifier.page, 'verify', { choiceValue: 'yes', textValue: reVerifyReason });
    settleReady = await settleBtn
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!settleReady) {
    const statusBar = await reVerifier.page.locator('#status').textContent();
    throw new Error(`Settle step never became actionable after the re-verification. Status bar: ${statusBar || '(empty)'}`);
  }

  let settled = false;
  for (let attempt = 0; !settled && attempt < 15; attempt++) {
    await clickInCard(submitter.page, summary, '.settle-contribution');
    await completeFlow(submitter.page, 'settle', { textValue: settleNote });
    settled = await card
      .locator('.contribution-pill:text-is("accepted")')
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!settled) {
    const statusBar = await submitter.page.locator('#status').textContent();
    throw new Error(`Status pill never flipped to accepted. Status bar: ${statusBar || '(empty)'}`);
  }
  console.log('CONTRIBUTION STATUS PILL: accepted after appeal');
}

// The /round page hosts ONE always-present settlement wizard; the round's
// stage selects the flow (audit at Open, reckon at Audited, publish at
// Reckoned). Drive the current stage's flow, then wait for the stage chip to
// flip to the expected stage name. After publish the round ADVANCES (next
// round, stage Open again) — hence afterStage for publish is 'Open'.
async function runRoundSpineStep(actor, flowId, note, choiceValue = null, afterStage) {
  await nav(actor.page, '/round');
  let driven = false;
  for (let attempt = 0; !driven && attempt < 15; attempt++) {
    if (await actor.page.locator(`.wizard-flow[data-flow-id="${flowId}"]`).count()) {
      await completeFlow(actor.page, flowId, { choiceValue, textValue: note ?? '' });
      driven = await actor.page
        .locator(`.round-step--current:text-is("${afterStage}")`)
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true, () => false);
    } else {
      // A slow apply unmounts this flow after the 3s chip window above — the
      // already-flipped chip must count as driven here, or we'd throw
      // "stuck" on a step that actually landed.
      driven = await actor.page
        .locator(`.round-step--current:text-is("${afterStage}")`)
        .waitFor({ state: 'visible', timeout: 1000 })
        .then(() => true, () => false);
    }
  }
  if (!driven) {
    const statusBar = await actor.page.locator('#status').textContent();
    throw new Error(`Round spine stuck at ${flowId}; stage chip never reached "${afterStage}". Status bar: ${statusBar || '(empty)'}`);
  }
  console.log(`ROUND STAGE: ${afterStage.toLowerCase()}`);
}

(async () => {
  let alice = null;
  let bob = null;
  let carol = null;
  let dave = null;
  try {
  const aliceName = 'alice_e2e_' + Math.floor(Math.random() * 10000);
  const bobName = 'bob_e2e_' + Math.floor(Math.random() * 10000);
  const carolName = 'carol_e2e_' + Math.floor(Math.random() * 10000);
  const daveName = 'dave_e2e_' + Math.floor(Math.random() * 10000);
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

  // Third and fourth live pages for the phase-3 contribution flows: schema
  // v2's C_1 verify step needs TWO distinct verifiers, and the reciprocity
  // guard is strictly one check per MEMBER PAIR (per-pair verify-once plus
  // the mutual loop bar) — the flows need 5 checks but three members carry
  // only 3 pairs, so dave (page 4) is structurally required (see the flows).
  carol = await runUser(carolName);
  console.log('Third page registered:', carolName);
  dave = await runUser(daveName);
  console.log('Fourth page registered:', daveName);

  // --- Contribution wizard flow (submit -> verify -> settle) ---
  // Runs before quadratic voting: the settled contributions fund the round's
  // $RES bounties and — since phase 2 — the C-dimension tallies that set the
  // salient quadratic vote balance ($RES itself no longer gates votes).

  // Cycle 1 (phase-3 two-verifier C_1, HARM path): alice submits a Building
  // claim; bob checks it (quorum 1/2) answering 'yes-harm' — the reduced
  // verdict; carol's second check completes the all-parties quorum (2/2) and
  // carries the prior verdict forward automatically (priorHarm from the
  // mirror); alice settles, attesting both verifiers. The verified harm
  // halves the outcome BEFORE payment: alice's bounty is 6 $RES (12 × 0.5,
  // surfaced by the card's harm receipt asserted in the flow), while each
  // verifier still earns a check credit (2 $RES); alice's C_1 tally is
  // the halved delta 0.5 (it feeds the salient proposal below and the
  // published RCT).
  // The wizard lives on /contribute — every page that acts in a cycle navigates
  // there ONCE before its first act (nav is a plain router-link click; repeat
  // clicks inside retry loops are unnecessary and could race the demo clock).
  await nav(alice.page, '/contribute');
  await nav(bob.page, '/contribute');
  await nav(carol.page, '/contribute');
  await runTwoVerifierCycle(alice, bob, carol, '1', 'Wizard-built e2e demo ' + Math.floor(Math.random() * 10000), 'built and matches the claim', 'accepting the two-verifier outcome', 'yes-harm');

  // Cycle 2: bob submits a Recording claim; dave verifies (alice is barred —
  // her pair with bob was consumed when bob checked her C_1); bob settles.
  // Pays bob the C_2 base credit (3 $RES) and dave a check credit (2 $RES);
  // bob's settle gives him a C_2 tally of 1.
  await nav(dave.page, '/contribute');
  await runWizardCycle(bob, dave, '2', 'Wizard-recorded e2e demo ' + Math.floor(Math.random() * 10000), 'the record is attributed and findable', 'accepting the verified outcome');

  // --- Phase-3 appeal flow: reject -> appeal -> re-verify -> settle ---
  // Pair ledger so far (one check per pair, mutual bar kills both
  // directions): a-b, a-c (cycle 1), b-d (cycle 2). The appealed submission
  // belongs to carol (page 3): bob's check REJECTS it (the decision radio
  // answered 'no' — pair b-c), carol appeals from her page via the appeal
  // wizard,
  // dave's re-verification overturns it (pair c-d — fresh), carol settles.
  // dave's re-verify button title at that point reads his accuracy stat —
  // one check, upheld once by cycle 2's settlement-attested verifier list.
  await runAppealFlow(carol, bob, dave, '2', 'Appealed e2e demo ' + Math.floor(Math.random() * 10000), 'the record does not match the claim', 'the evidence was misread — the record stands', 'the appealed re-review finds the record accurate', 'accepting the re-verified outcome');

  // --- Round spine close (phase 2) ---
  // alice (any member — spine policies are 'role:member OR role:custodian')
  // audits the round fair against the registered v1 calibration, reckons,
  // then completes: complete_round aggregates the THREE accepted
  // contributions, mirroring each entry's harm onto the totals —
  // alice's harm-reduced C_1 contributes 0.5 (0.5 factor), bob's C_2 1 and
  // carol's appealed-and-re-verified C_2 1 (alpha defaults to 1) — so alice
  // publishes 0.5 cumulative RCT and advances to Round 2.
  console.log('Closing round 1 through the spine (audit → reckon → publish)');
  // Each spine step navigates to /round itself; the round's stage selects the
  // always-present wizard's flow and the stage chip flip is the assertion.
  await runRoundSpineStep(alice, 'audit', 'phase-4a e2e audit note: fair against v1', 'fair', 'Audited');
  await runRoundSpineStep(alice, 'reckon', 'phase-4a e2e reckon note: records settled', null, 'Reckoned');
  // Publish submits the round's settlement directly (no entry button) and
  // ADVANCES the round — the next round opens at stage Open again; success is
  // proven by the chip flipping back to Open (the Round 2 panel label and the
  // post-publish aggregation asserts below keep their own waits).
  await runRoundSpineStep(alice, 'publish', null, null, 'Open');

  // --- Quadratic voting (base-only funding since phase 2) ---
  // Without salient dims a quadratic proposal grants the base balance (3), so
  // alice's first vote (cumulative cost 1) counts and her second (cumulative
  // 1+4=5 > 3) is rejected by the server — surfaced as 'Vote error' in the
  // status bar.
  // Back on the proposals page for the quadratic voting block.
  await nav(alice.page, '/proposals');
  const qId = await createProposal(alice.page, 'Multi-choice quadratic', 'quadratic', 'Red, Green, Blue');
  console.log('Created multi-choice quadratic proposal', qId);

  // Retry-until-counted: the demo clock can swallow clicks.
  let firstLanded = false;
  for (let attempt = 0; !firstLanded && attempt < 15; attempt++) {
    await voteOption(alice.page, qId, 'Red');
    const tallies = await getOptionTallies(alice.page, qId);
    firstLanded = tallies[0] === '1';
  }
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
  // carol and dave registered (live pages) back in the contribution flows;
  // the candidates list is every member set — alphabetical, so alice is
  // still the first checkbox candidate on every page and wins both cycles
  // (2-0, no tie, no runoff).
  //
  // This section is the wire-drift regression proof (issue #37): finalize
  // makes the server broadcast a SERVER-signed sync_roles op, which under
  // the drift (vendored wire-v4 client wasm vs wire-v5 server ops) no page
  // could apply — 'Failed to apply update: Operation.deserialize failed' —
  // leaving every signer at their pre-grant key version (key_stale on their
  // next op). npm run copy-wasm re-synced the vendored binary (wire v5) and
  // server/test/crabs-wasm-format.test.ts guards the pair, so the asserts
  // below must hold: the grant applies (custodians badge), the custodian
  // controls render, and the post-election ops are accepted.

  // Start the election from alice's page — elections live on /elections.
  await nav(alice.page, '/elections');
  await alice.page.click('#start-election');
  await alice.page.waitForTimeout(1500);

  // Alice and bob each cast a ballot (checkboxes scoped to their election card).
  await alice.page.locator('.ballot-option').first().waitFor({ state: 'visible', timeout: 30000 });
  const checkboxes = await alice.page.$$('.ballot-option');
  await checkboxes[0].click(); // alice picks first candidate
  await alice.page.click('#election-area button.button--primary');
  await alice.page.waitForTimeout(1500);

  // bob's ballot: his page was still on /contribute — navigate once, first.
  await nav(bob.page, '/elections');
  await bob.page.locator('.ballot-option').first().waitFor({ state: 'visible', timeout: 30000 });
  const bobCheckboxes = await bob.page.$$('.ballot-option');
  await bobCheckboxes[0].click();
  await bob.page.click('#election-area button.button--primary');
  await bob.page.waitForTimeout(1500);

  // Wait for expiry (60s), then finalize.
  await alice.page.waitForTimeout(62000);
  await alice.page.click('.finalize-election');
  await alice.page.waitForTimeout(2000);

  // Finalize makes the server broadcast a SERVER-signed sync_roles op — the
  // call the wire-drift bug broke (failed deserialize → 'Failed to apply
  // update'). The demo clock re-renders the custodians list every second, so
  // alice's seat badge appearing proves the grant APPLIED on her client,
  // which is also what catches her key version up (without it her next op
  // dies key_stale on the server).
  // The custodians list (with the badges) lives on /custodians — navigate
  // once BEFORE the retry loop so the clock re-renders can't race the nav.
  await nav(alice.page, '/custodians');
  let syncRolesApplied = false;
  for (let attempt = 0; !syncRolesApplied && attempt < 15; attempt++) {
    syncRolesApplied = await alice.page
      .locator('#custodians .member-item__badge', { hasText: aliceName })
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  const postFinalizeStatus = (await alice.page.locator('#status').textContent()) || '';
  if (!syncRolesApplied) {
    throw new Error(`sync_roles grant never applied on the client after finalize (custodians list never showed alice). Status bar: ${postFinalizeStatus || '(empty)'}`);
  }
  if (postFinalizeStatus.includes('Failed to apply update') || postFinalizeStatus.includes('key_stale')) {
    throw new Error(`sync_roles apply surfaced an error after finalize. Status bar: ${postFinalizeStatus}`);
  }
  console.log('SYNC_ROLES APPLY: applied — alice in the custodians list, key version caught up');

  // Custodian controls render once the grant applied (alice is a winner with
  // the most picks). The set_token_config custodian op and its form were
  // deleted; since phase 2, votes are gated by the salient-derived balance
  // (not $RES), so skip straight to member removal — the removal is also
  // alice's first custodian-signed op after the grant, so a failed key
  // catch-up would surface here as 'Remove error: ...'. Single shot (no
  // retry): a re-click could target the next member's row after re-render.
  const removeBtn = alice.page.locator('.remove-member').first();
  let removedName = null;
  let controlsReady = false;
  for (let attempt = 0; !controlsReady && attempt < 10; attempt++) {
    controlsReady = (await removeBtn.count()) > 0;
    if (!controlsReady) await alice.page.waitForTimeout(1000);
  }
  if (!controlsReady) {
    throw new Error('Custodian controls (.remove-member) never rendered even though the sync_roles grant applied.');
  }
  await removeBtn.click({ force: true });
  await alice.page.waitForTimeout(1500);
  const removeStatus = (await alice.page.locator('#status').textContent()) || '';
  if (!removeStatus.includes('removed from the DAO.')) {
    throw new Error(`Custodian member removal never succeeded. Status bar: ${removeStatus || '(empty)'}`);
  }
  removedName = (removeStatus.match(/^(.+?) removed from the DAO\.$/) || [])[1] || null;
  console.log('CUSTODIAN REMOVAL ACCEPTED:', removedName);

  console.log('Custodian election smoke flow completed');

  // --- Phase-2 round extension: salient quadratic on the published round ---
  // Round 2 is open after the spine. alice publishes her C_1 contribution's
  // harm-adjusted tally (0.5: match 1 × reduced factor 0.5; alpha defaults
  // to 1) into the proposal's salient mask, so her vote balance is
  // base 3 + 0.5x1 = 3.5: the first vote (cumulative 1) counts and the
  // second (cumulative 1+4=5 > 3.5) is rejected.
  //
  // This creation is the post-election acceptance proof (issue #37): under
  // the wasm wire-drift it died key_stale — sync_roles never applied, so
  // alice kept signing at her pre-grant key version. submitOp resolves only
  // on the server's op_accepted, so the rendered card plus the tallies below
  // prove the fix (apply + catch-up) end-to-end.
  let sId = null;
  // Proposals live on /proposals — alice's page just came from /custodians.
  await nav(alice.page, '/proposals');
  sId = await createProposal(alice.page, 'Salient quadratic round 2', 'quadratic', 'One, Two, Three', ['1']);
  console.log('Created C_1-salient quadratic proposal on round 2', sId);

  if (sId) {
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
  }

  // Round panel advanced with the spine and the published RCT badge shows —
  // carrying the harm-adjusted aggregate: alice's lone published entry is the
  // reduced C_1, so the mirrored factor lands in the badge (0.5, not 1).
  // The round label is /round-only, the RCT badge is /custodians-only.
  await nav(alice.page, '/round');
  const roundLabel = await alice.page.locator('.round-label').textContent();
  console.log('ROUND PANEL:', roundLabel);
  if (!roundLabel.startsWith('Round 2')) {
    throw new Error(`Expected round panel to show 'Round 2 ...', got '${roundLabel}'`);
  }
  await nav(alice.page, '/custodians');
  const rctBadge = await alice.page.locator(`[data-member-rct="${aliceName}"]`).textContent();
  console.log('ALICE RCT BADGE:', rctBadge);
  if (rctBadge.trim() !== '0.5 RCT') {
    throw new Error(`Expected alice's harm-adjusted RCT badge to read '0.5 RCT', got '${rctBadge.trim()}'`);
  }

  // --- Second election cycle (compact repeat, issue #37) ---
  // One grant is easy; the drift bug compounded across cycles, so repeat
  // the loop: start → ballots → expiry → finalize → sync_roles apply → and
  // prove the catch-up again with an accepted post-cycle op. Whoever the
  // removal took out cannot cast ballots (cast_ballot needs
  // member/custodian), so that page is skipped.
  console.log('Second election cycle: start → ballot → expiry → finalize');
  const secondCycleVoters = [bob, carol, dave]
    .map((user, i) => ({ user, name: [bobName, carolName, daveName][i] }))
    .filter((v) => v.name !== removedName);
  if (!secondCycleVoters.length) {
    throw new Error('No second-cycle voter left: the removal took the only other member with a live page');
  }
  const secondVoter = secondCycleVoters[0];

  // Ballot submit with retry: the demo clock re-renders the election cards
  // every second — it detaches Playwright element handles mid-action and can
  // swallow a click in flight — so click from inside the page (check the
  // first candidate, press the open card's ballot submit) and retry until
  // the card marks the ballot as cast ('you voted' in the countdown line).
  // Cycle 1's card is finalized (no ballot form), so the ballot widgets on
  // these pages belong to this second election only.
  const castRepeatBallot = async (user, label) => {
    await user.page.locator('.ballot-option').first().waitFor({ state: 'visible', timeout: 30000 });
    let cast = false;
    for (let attempt = 0; !cast && attempt < 10; attempt++) {
      await user.page.evaluate(() => {
        const first = [...document.querySelectorAll('.ballot-option')][0];
        if (first) first.click();
        const submit = [...document.querySelectorAll('#election-area button')]
          .find((b) => b.textContent.includes('Submit ballot'));
        if (submit) submit.click();
      });
      cast = await user.page
        .locator('.proposal-card__type:has-text("you voted")')
        .first()
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true, () => false);
    }
    if (!cast) {
      const st = await user.page.locator('#status').textContent();
      throw new Error(`Second-cycle ballot never registered on ${label}'s page. Status bar: ${st || '(empty)'}`);
    }
  };

  await nav(alice.page, '/elections');
  await alice.page.click('#start-election');
  await alice.page.waitForTimeout(1500);
  await castRepeatBallot(alice, 'alice');
  await nav(secondVoter.user.page, '/elections');
  await castRepeatBallot(secondVoter.user, secondVoter.name);

  await alice.page.waitForTimeout(62000);
  await alice.page.click('.finalize-election');
  await alice.page.waitForTimeout(2000);
  const repeatFinalizeStatus = (await alice.page.locator('#status').textContent()) || '';
  if (!repeatFinalizeStatus.includes('Election finalized.')) {
    throw new Error(`Second finalize never reported success (a failed sync_roles apply would overwrite the status). Status bar: ${repeatFinalizeStatus || '(empty)'}`);
  }

  // The strongest repeat-cycle assert: alice's first client-signed op after
  // the SECOND key-version bump must be accepted by the server (submitOp
  // resolves only on op_accepted) and rendered back.
  // Post-cycle proposal: alice's page just came from /elections.
  await nav(alice.page, '/proposals');
  const c2Id = await createProposal(alice.page, 'Second-cycle direct', 'direct', 'Yes, No');
  console.log('Post-second-cycle op accepted:', c2Id);
  const c2Status = (await alice.page.locator('#status').textContent()) || '';
  if (c2Status.includes('Rejected:') || c2Status.includes('key_stale') || c2Status.includes('Failed to apply update')) {
    throw new Error(`Post-second-cycle op failed. Status bar: ${c2Status}`);
  }
  console.log('SECOND ELECTION CYCLE: sync_roles applied and the post-cycle op accepted');

  console.log('Smoke test passed');
  } catch (err) {
    // Dump per-page diagnostics so failures stay legible: the status bar
    // (rendered on every route) and short snapshots of the lists. These are
    // route-scoped in the SPA, so each read gets a short timeout — a page
    // sitting on a route without that node just reports its route instead of
    // stalling the dump for 30s.
    for (const [name, u] of [['alice', alice], ['bob', bob], ['carol', carol], ['dave', dave]]) {
      if (!u?.page) continue;
      try {
        console.log(`[${name} status]`, await u.page.locator('#status').textContent({ timeout: 2000 }));
        console.log(`[${name} round]`, await u.page.locator('.round-label').textContent({ timeout: 2000 }).catch(() => '(not on /round)'));
        console.log(`[${name} proposals]`, (await u.page.locator('#proposals').innerHTML({ timeout: 2000 }).catch(() => '(not on /proposals)')).slice(0, 400));
        console.log(`[${name} contributions]`, (await u.page.locator('#contributions-list').innerHTML({ timeout: 2000 }).catch(() => '(not on /contribute)')).slice(0, 400));
      } catch (e) {
        console.log(`[${name} debug]`, e.message);
      }
    }
    throw err;
  } finally {
    for (const u of [alice, bob, carol, dave]) {
      if (u) { try { await u.browser.close(); } catch (err) { /* already closed */ } }
    }
  }
})();
