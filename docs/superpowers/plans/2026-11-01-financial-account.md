# Financial Account Page (Slice #5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/account` becomes the read-only financial account: `$RES`/`RCT` balances with plain-language hints, the 22-dimension tallies strip (nonzero-first), and the earned-money ledger —
fed by a pure TDD'd projection over the feed mirror.

**Architecture:** One pure module (`client/src/wizard/ledger.ts` — the lifecycle.ts precedent) +
one page (`AccountPage.vue` replacing the placeholder). No machine/shell/store-op/route changes.

**Tech Stack:** shared TS (jest + ts-jest, TDD), Vue 3 SFC + pinia, Playwright e2e.

Spec: `docs/superpowers/specs/2026-11-01-financial-account-design.md`

---

## Conventions

- npm from repo root; commits direct to master; never stage outside the task list; SFC
  trailing newlines; jest suites in `server/test/`; tick-gated reads in every page computed.

## Final file layout

```
Created:
  client/src/wizard/ledger.ts                   # LedgerLine + ledgerLines (TDD)
  server/test/ledger.test.ts                    # its suite (TDD)
  client/src/components/account/AccountPage.vue # /account
Deleted:
  client/src/components/account/AccountPlaceholder.vue
Modified:
  client/src/app/router.ts                      # /account → AccountPage.vue
  test-voting-browser.js                        # + /account asserts after the cycles
```

---

## Task 1: the ledger projection (TDD)

**Files:**
- Create: `client/src/wizard/ledger.ts`
- Test: `server/test/ledger.test.ts`

- [ ] **Step 1: write the failing test** — `server/test/ledger.test.ts`:

```ts
import { ledgerLines, LedgerLine, LedgerContribution } from '../../client/src/wizard/ledger';
import type { FeedEvent } from '../../shared/src/feed';
import { RES_CONFIG } from '../../shared/src/policies';

const contrib = (overrides: Partial<LedgerContribution> = {}): LedgerContribution => ({
  contributionId: 'c-1',
  dims: { '2': 1 },
  harm: 'none',
  ...overrides,
});

function ev(type: string, actor: string, targetId: string, at: number): FeedEvent {
  return { index: 1, type, actor, at, round: 1, summary: type, targetId } as FeedEvent;
}

describe('ledgerLines', () => {
  it('a settled contribution IS the submitter income — harm-scaled, labeled', () => {
    const lines = ledgerLines(
      [ev('contribution_settled', 'alice', 'c-1', 2000)],
      [contrib({ contributionId: 'c-1', dims: { '1': 1 }, harm: 'none', summary: 'built a bridge' })],
      'alice',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ at: 2000, amount: RES_CONFIG.buildingBounty, sign: '+' });
    expect(lines[0].label).toContain('bounty');
    expect(lines[0].label).toContain('built a bridge');
  });

  it('harm scales the settle line (reduces, voids) and names the harm', () => {
    const lines = ledgerLines(
      [ev('contribution_settled', 'alice', 'c-1', 2000)],
      [contrib({ contributionId: 'c-1', dims: { '1': 1 }, harm: 'reduced', summary: 'x' })],
      'alice',
    );
    expect(lines[0].amount).toBeLessThan(RES_CONFIG.buildingBounty);
    expect(lines[0].label).toContain('harm');
    const voided = ledgerLines(
      [ev('contribution_settled', 'alice', 'c-1', 2000)],
      [contrib({ contributionId: 'c-1', dims: { '1': 1 }, harm: 'voided', summary: 'x' })],
      'alice',
    );
    expect(voided[0].amount).toBe(undefined);   // voided: no payment
    expect(voided[0].label).toContain('voided');
  });

  it('verification checks pay the VERIFIER, not the submitter', () => {
    const lines = ledgerLines(
      [ev('contribution_verified', 'bob', 'c-1', 3000), ev('contribution_settled', 'alice', 'c-1', 4000)],
      [contrib({ contributionId: 'c-1', dims: { '2': 1 }, summary: 'a record' })],
      'bob',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: RES_CONFIG.verificationCheckCredit, sign: '+' });
    expect(lines[0].label).toContain('a record');
    const aliceView = ledgerLines(
      [ev('contribution_verified', 'bob', 'c-1', 3000), ev('contribution_settled', 'alice', 'c-1', 4000)],
      [contrib({ contributionId: 'c-1', dims: { '2': 1 }, summary: 'a record' })],
      'alice',
    );
    expect(aliceView).toHaveLength(1);   // only HER settle line
    expect(aliceView[0].amount).toBe(RES_CONFIG.recordingBaseCredit);
  });

  it('zero-amount consequential events never render; unknown contributions degrade to "?"', () => {
    const lines = ledgerLines(
      [ev('proposal_created', 'alice', 'p-1', 1000), ev('reassign_verifiers', 'bob', 'c-9', 1500), ev('contribution_verified', 'bob', 'c-9', 2000)],
      [],
      'bob',
    );
    expect(lines).toHaveLength(1);           // the verified check on an AGED-OUT contribution
    expect(lines[0].sign).toBe('?');
    expect(lines[0].amount).toBeUndefined();
  });

  it('empty mirror history is an empty ledger', () => {
    expect(ledgerLines([], [], 'alice')).toEqual([]);
  });
});
```

- [ ] **Step 2: run to FAIL** — `npx jest server/test/ledger.test.ts --runInBand` → FAIL (module missing).

- [ ] **Step 3: write `client/src/wizard/ledger.ts`:**

```ts
// Pure earned-money projection for the account page. Protocol truth lives in
// the registers (the BALANCE is authoritative); this module retells the feed
// mirror as line items — same shared payout math the handlers and receipts
// use, so the ledger cannot disagree with the machine. Vote spends are NOT
// listed (the feed carries no vote rows by design — rule D2).
import { harmFactorFor, paymentFor, DIMENSIONS } from '../../../shared/src/contribution';
import { RES_CONFIG } from '../../../shared/src/policies';
import type { FeedEvent } from '../../../shared/src/feed';

export interface LedgerContribution {
  contributionId: string;
  dims: Record<string, number>;
  harm?: string;
  summary?: string;
}

export interface LedgerLine {
  at: number;
  label: string;
  amount?: number;            // absent when the data degrades
  sign: '+' | '−' | '?';
}

function dimLabel(dims: Record<string, number>): string {
  const k = Object.keys(dims)[0];
  const def = DIMENSIONS[Number(k)];
  return def ? `C_${def.index}` : 'C_?';
}

export function ledgerLines(feedEvents: FeedEvent[], contributions: LedgerContribution[], viewer: string): LedgerLine[] {
  const lines: LedgerLine[] = [];
  const byId = new Map(contributions.map((c) => [c.contributionId, c]));
  for (const e of feedEvents) {
    if (e.type === 'contribution_settled' && e.actor === viewer) {
      const c = byId.get(e.targetId ?? '');
      if (!c) {
        lines.push({ at: e.at, label: 'settled contribution (aged out of the mirror)', amount: undefined, sign: '?' });
        continue;
      }
      if (c.harm === 'voided') {
        lines.push({ at: e.at, label: `${c.summary ?? 'contribution'} — settled, outcome voided (harm)`, amount: undefined, sign: '−' });
        continue;
      }
      const base = Object.entries(c.dims).reduce((sum, [k, match]) => sum + paymentFor(Number(k), match), 0);
      const amount = c.harm && c.harm !== 'none' ? base * harmFactorFor(c.harm as HarmVerdictFromLedger) : base;
      lines.push({
        at: e.at,
        label: `${dimLabel(c.dims)} settled — "${c.summary ?? 'contribution'}"${c.harm && c.harm !== 'none' ? ' (harm reduced)' : ''}`,
        amount,
        sign: '+',
      });
    } else if (e.type === 'contribution_verified' && e.actor === viewer) {
      const c = byId.get(e.targetId ?? '');
      lines.push({
        at: e.at,
        label: c ? `verification check — "${c.summary ?? 'contribution'}"` : 'verification check (contribution aged out of the mirror)',
        amount: c ? RES_CONFIG.verificationCheckCredit : undefined,
        sign: c ? '+' : '?',
      });
    }
  }
  return lines;
}
```

(type note: `HarmVerdictFromLedger` — import `HarmVerdict` from `../../../shared/src/contribution`
instead; the harm field is a string on the structural type, cast at the scale call. Adjust while
implementing so typecheck is clean.)

- [ ] **Step 4: run to PASS + full `npm test` green.**

- [ ] **Step 5: commit**

```bash
git add client/src/wizard/ledger.ts server/test/ledger.test.ts
git commit -m "feat(ledger): pure earned-money projection (TDD)"
```

---

## Task 2: the page + route

**Files:**
- Create: `client/src/components/account/AccountPage.vue`
- Modify: `client/src/app/router.ts` (account route → `AccountPage.vue`)
- Delete: `client/src/components/account/AccountPlaceholder.vue`

- [ ] **Step 1: write `AccountPage.vue`:**

```vue
<template>
  <SectionHeading number="06" eyebrow="Account" title="Your ledger">
    <template #lede>What the machine holds in your name: the balances, the dimension tallies your
      accepted work earned, and the money story of your settled contributions and
      verification checks.</template>
  </SectionHeading>

  <div class="grid">
    <Panel number="01" kicker="Balances">
      <div class="balance-row">
        <span class="balance mono" id="account-res">🪙 {{ res ?? '—' }} $RES</span>
        <span class="balance mono" id="account-rct">{{ rct ?? '—' }} RCT</span>
      </div>
      <p class="muted">$RES moves only through verified work. RCT is your aggregated weight in the settlement cycle's payouts.</p>
    </Panel>

    <Panel number="02" kicker="Dimension tallies">
      <div id="dim-tallies" class="tallies">
        <span v-for="t in visibleTallies" :key="t.code" class="tally mono">{{ t.code }} {{ t.cls }} — {{ t.value }}</span>
        <span v-if="hiddenCount > 0" class="muted tally__rest">{{ hiddenCount }} dimensions untouched</span>
      </div>
    </Panel>

    <Panel number="03" kicker="Ledger" class="grid-wild">
      <div id="ledger" class="ledger">
        <p v-if="lines.length === 0" class="muted">Nothing earned yet — settled work and verification checks appear here.</p>
        <div v-for="(line, i) in lines" :key="i" class="ledger-line">
          <span class="mono ledger-line__clock">{{ clock(line.at) }}</span>
          <span :class="['ledger-line__amount', `ledger-line__amount--${line.sign}`]">
            {{ line.amount !== undefined ? `${line.sign}${line.amount}` : line.sign }}
          </span>
          <span class="ledger-line__text">{{ line.label }}</span>
        </div>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { DIMENSIONS, paymentFor } from '@shared/contribution';
import { ledgerLines } from '../../wizard/ledger';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

// (FIX while implementing: the template's `paymentFor` import is NOT used by
// the page script — drop it; the tallies/balances/ledger all read accessors
// + the projection. This note exists because the plan author drafted the
// imports before the script; typecheck will flag it.)

const ds = useDaoStore();

const res = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : undefined; });
const rct = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getRctBalance(ds.username) : undefined; });

const visibleTallies = computed(() => {
  void ds.tick;
  if (!ds.dao || !ds.username) return [];
  return DIMENSIONS
    .map((d) => ({ code: `C_${d.index}`, cls: d.cls, value: ds.dao!.getDimensionBalance(ds.username, d.index) }))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value);
});
const hiddenCount = computed(() => DIMENSIONS.length - visibleTallies.value.length);

const lines = computed(() => {
  void ds.tick;
  return ledgerLines(ds.feedEvents(), contributionsForLedger(), ds.username);
});

// (FIX while implementing: `contributionsForLedger()` maps the mirror into
// the structural LedgerContribution inputs — from ds.dao.getContributions():
// record.contributionId/dims/summary + entry.harm. Implement as a small
// computed-local array; the projection stays pure.)

function clock(atMs: number): string { return new Date(atMs).toTimeString().slice(0, 8); }
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }
@media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .grid-wild { grid-column: 1 / -1; } }
.balance-row { display: flex; gap: var(--space-5); align-items: baseline; }
.balance { font-size: 1.35rem; color: var(--ink); }
.tallies { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
.tally { font-size: .78rem; border: 1px solid var(--line); border-radius: 999px; padding: .15rem var(--space-3); color: var(--jade); }
.tally__rest { border: none; padding: 0; color: var(--faint); }
.ledger { display: flex; flex-direction: column; gap: var(--space-2); }
.ledger-line { display: flex; align-items: baseline; gap: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2) var(--space-3); background: var(--glass); }
.ledger-line__clock { color: var(--faint); font-size: .75rem; flex: 0 0 auto; }
.ledger-line__amount { flex: 0 0 auto; font-family: var(--font-mono); font-weight: 700; }
.ledger-line__amount--\+ { color: var(--jade); }
.ledger-line__amount--\− { color: var(--danger); }
.ledger-line__amount--\? { color: var(--muted); }
.ledger-line__text { flex: 1 1 auto; min-width: 0; font-size: .875rem; color: var(--ink-soft); }
</style>
```

(Apply the two FIX-noted corrections while implementing: drop the unused import; implement the
structural contributions mapping — simplest inside the `lines` computed:

```ts
const entries = computed(() => {
  void ds.tick;
  return ds.dao?.getContributions() ?? [];
});
const lines = computed(() => {
  void ds.tick;
  return ledgerLines(ds.feedEvents(), entries.value.map((e) => ({
    contributionId: e.record.contributionId, dims: e.record.dims,
    harm: e.harm, summary: e.record.summary,
  })), ds.username);
});
```

)

- [ ] **Step 2: router** — swap the account route's component import:

```ts
    { path: '/account', name: 'account', component: () => import('../components/account/AccountPage.vue') },
```

- [ ] **Step 3: DELETE the placeholder** — `grep -rn "AccountPlaceholder" client/src` → 0 after.

- [ ] **Step 4: gates** — typecheck 0; `npm test` green; `npm run build:client` success.

- [ ] **Step 5: commit**

```bash
git add client/src/components/account client/src/wizard/ledger.ts server/test/ledger.test.ts client/src/app/router.ts
git commit -m "feat(account): the financial account page — balances, tallies, earned ledger"
```

---

## Task 3: e2e assertions

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: add the account section** after the existing cycles (before the election
  section if the flow's RES is still legible; put it right after the final settled cycle). The
  driver: `nav(page, '/account')` + asserts:

```js
  // ---------- account ----------
  console.log('The account page: balances + earned ledger');
  await nav(alice.page, '/account');
  await alice.page.locator('#account-res').waitFor({ state: 'visible', timeout: 10000 });
  const resShown = await alice.page.locator('#account-res').textContent();
  console.log('ACCOUNT RES:', (resShown ?? '').trim());
  const ledgerText = await alice.page.locator('#ledger').textContent();
  if (!ledgerText.includes('built a bridge')) throw new Error('ledger missing the settled contribution line');
```

(exact expected strings come from the cycles' summaries — read the e2e's actual contribution
summaries and pin those; keep the assertion STRONG: presence of the bounty line for alice +
bob's verify line. Amounts are asserted in jest — the e2e pins presence + ordering (lines
newest-first).)

- [ ] **Step 2: node --check + commit**

Run: `node --check test-voting-browser.js` → clean.

```bash
git add test-voting-browser.js
git commit -m "test(e2e): the account page's balances + earned ledger asserted"
```

---

## Task 4: full verification + hand-back

**Files:** none expected.

- [ ] **Step 1:** stop the dev server (full PID chain; ports free).
- [ ] **Step 2:** `npm run build:client` → fresh `WAVEDB_PATH=/tmp/dao-5-e2e` server (background, real listen wait) → `node test-voting-browser.js` → `Smoke test passed`.
- [ ] **Step 3:** stop; `rm -rf /tmp/dao-5-e2e`; fresh server + `npm run dev:client` → `node scripts/feed-walk.mjs` → `FEED WALK PASSED`.
- [ ] **Step 4:** gates — `npm test` (16 suites green), `npm run typecheck:client` (0), `npm run build` (clean), devtools assert (only crabs.js/crabs.wasm), dialog grep 0.
- [ ] **Step 5:** restart `npm run dev` for the user (nohup + pidfile + boot line; leave running); `rm -rf /tmp/dao-5-e2e`.

Failures: test-script bugs fixed in place; page/projection bugs → BLOCKED with output.

---

## Self-review notes (executed)

- Spec coverage: balances + hints + tallies + ledger (Task 2), pure projection with degrade +
  D2 respect + single-source math (Task 1), e2e (Task 3), verification (Task 4). Earned-only +
  read-only + nonzero-first tallies per the spec decisions ✓.
- Type consistency: `ledgerLines(feedEvents, contributions, viewer)` — Task 2's call matches;
  `LedgerLine.sign` values match the page's CSS/ternary; the FIX-noted import/mapping gaps are
  called out inline for the implementer (the plan's own corrections pattern).