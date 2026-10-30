// Feed-page verification walk. Requires TWO servers running:
//   npm run dev:server (9000, fresh DB) + npm run dev:client (5173)
// Asserts the D1-D4 behavior: timeline mirrors consequential ops, votes stay
// invisible, the band projects, the spine publishes.
import { chromium } from 'playwright';

const BASE = process.env.WALK_BASE || 'http://localhost:5173';
const PASSWORD = 'TestPassword123!';

const fail = (msg) => { throw new Error(`WALK FAIL: ${msg}`); };

async function registerUser(browser, username) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE);
  await page.fill('#register-username', username);
  await page.fill('#register-password', PASSWORD);
  await page.fill('#register-password-confirm', PASSWORD);
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('#dashboard', { timeout: 30000 });
  return page;
}

const nav = (page, href) => page.click(`header nav a[href="${href}"]`);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await registerUser(browser, 'feed_walk_' + Math.floor(Math.random() * 10000));
  // Landed on the feed (D4).
  if (!(await page.url()).endsWith('/')) fail('post-login landing is not the feed');

  // Empty-ish feed is honest; create a proposal and expect the row.
  await nav(page, '/proposals');
  await page.fill('#proposal-title', 'Walk proposal');
  await page.fill('#proposal-description', 'walk');
  await page.click('#proposal-form button[type="submit"]');
  await page.waitForTimeout(2000);
  await nav(page, '/');
  let rows = await page.locator('.event-row').allTextContents();
  if (!rows.some((t) => t.includes('"Walk proposal" — direct proposal created') && t.includes('Round 1'))) fail(`proposal_created row missing; rows=${JSON.stringify(rows)}`);

  // A vote event must never appear (D2): vote Red on this proposal.
  await nav(page, '/proposals');
  const card = page.locator('.proposal-card:has(.proposal-card__title:text-is("Walk proposal"))').first();
  await card.locator('.vote-option', { hasText: 'Yes' }).click();
  await page.waitForTimeout(2000);
  await nav(page, '/');
  rows = await page.locator('.event-row').allTextContents();
  if (rows.some((t) => t.toLowerCase().includes('voted'))) fail('a vote event leaked into the timeline');
  if (rows.some((t) => t.includes('proposal executed'))) fail('execute event appeared without execution');

  // Band projects an actionable for the OTHER viewer: second page, proposal
  // open for voting → NeedsAttention lists it. The log replay is async
  // relative to the dashboard render (bootstrap() sets dao before replayLog
  // finishes), so poll for the projection instead of racing the ingest.
  const viewer2 = await registerUser(browser, 'feed_walk2_' + Math.floor(Math.random() * 10000));
  let attention = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    attention = await viewer2.locator('#needs-attention').textContent({ timeout: 250 });
    if (attention.includes('"Walk proposal" is open for voting')) break;
    await viewer2.waitForTimeout(250);
  }
  if (!attention.includes('"Walk proposal" is open for voting')) fail(`attention band missing the open proposal: ${attention}`);

  // Spine: the /round wizard is always present; audit is the stage's flow.
  await nav(viewer2, '/round');
  const auditFlow = viewer2.locator('.wizard-flow[data-flow-id="audit"]');
  await auditFlow.waitFor({ state: 'visible', timeout: 10000 });
  await auditFlow.locator('.wizard-option[value="fair"]').check();
  await auditFlow.locator('.wizard-next').click();
  await auditFlow.locator('textarea').fill('feed walk audit note');
  await auditFlow.locator('.wizard-next').click();
  await auditFlow.locator('.wizard-submit').click();
  await viewer2.waitForTimeout(2000);
  await nav(viewer2, '/');
  rows = await viewer2.locator('.event-row').allTextContents();
  if (!rows.some((t) => t.includes('round 1 audited — fair'))) fail(`round_audited row missing; rows=${JSON.stringify(rows)}`);

  // Publish path needs accepted contributions — skip (covered by the main
  // e2e); assert the RECKON step event instead. The reckoning flow mounts
  // when the stage is Audited; give the op its 2000ms then move on.
  await nav(viewer2, '/round');
  const reckonFlow = viewer2.locator('.wizard-flow[data-flow-id="reckon"]');
  if (await reckonFlow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
    // A draft from an earlier attempt may resume straight into review — drive
    // defensively: fill the note only if the textarea is present, then submit.
    const textarea = reckonFlow.locator('textarea');
    if ((await textarea.count()) > 0) {
      await textarea.first().fill('feed walk reckon note');
      await reckonFlow.locator('.wizard-next').click();
    }
    await reckonFlow.locator('.wizard-submit').click();
    await viewer2.waitForTimeout(2000);
  }
  await nav(viewer2, '/');
  rows = await viewer2.locator('.event-row').allTextContents();
  if (!rows.some((t) => t.includes('round 1 reckoned — ready to complete'))) fail('round_reckoned row missing');

  console.log('FEED WALK PASSED');
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
