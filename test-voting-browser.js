const { chromium } = require('playwright');

const PASSWORD = 'TestPassword123!';
const BASE_URL = 'http://localhost:9000/';

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

(async () => {
  const alice = await runUser('alice_e2e_' + Math.floor(Math.random() * 10000));
  const directId = await createProposal(alice.page, 'Multi-choice direct', 'direct', 'Alpha, Beta, Gamma');
  console.log('Created multi-choice direct proposal', directId);

  await voteOption(alice.page, directId, 'Beta');

  const bob = await runUser('bob_e2e_' + Math.floor(Math.random() * 10000));
  await voteOption(bob.page, directId, 'Alpha');

  const directTallies = await getOptionTallies(alice.page, directId);
  console.log('DIRECT TALLIES:', directTallies);
  if (JSON.stringify(directTallies) !== JSON.stringify(['1', '1', '0'])) {
    throw new Error(`Expected ['1','1','0'] on direct proposal, got ${JSON.stringify(directTallies)}`);
  }

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
  await alice.page.waitForSelector('#token-config-form:not(.hidden)', { timeout: 30000 });
  await alice.page.fill('#config-interval', '1000');
  await alice.page.fill('#config-rate', '5');
  await alice.page.click('#token-config-form button[type="submit"]');
  await alice.page.waitForTimeout(1500);

  // Remove dave if alice is a custodian and dave is listed.
  const removeBtn = alice.page.locator('.remove-member').first();
  if (await removeBtn.count()) {
    await removeBtn.click({ force: true });
    await alice.page.waitForTimeout(1500);
  }

  console.log('Custodian election smoke flow completed');

  await alice.browser.close();
  await bob.browser.close();
  console.log('Smoke test passed');
})();
