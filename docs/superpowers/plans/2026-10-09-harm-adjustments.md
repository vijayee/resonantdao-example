# Harm Adjustments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the delta formula's harm term per `docs/superpowers/specs/2026-10-09-harm-adjustments-design.md` — a `harm` verdict on verify ops (none / reduced / voided), fixed pilot factor 0.5, applied to submitter bounty + dimension deltas + aggregation totals before payment; verifier per-check credit never adjusted.

**Architecture:** Harm rides entirely in payload bytes (same PoC trust class as dims/submitter): the verify payload carries its own verdict + the prior check's verdict (`priorHarm`), the handler computes strongest-wins and multiplies; `complete_round` mirrors the same factor from each entry so the published RCT stays consistent with adjusted tallies; no new ops, no new registers — the durable trace is the verify explanation record plus the adjusted balances.

**Tech Stack:** TypeScript, crabs-wasm (CRABS), WaveDB, Vite/esbuild client, Jest, Playwright e2e.

---

## Baseline

- HEAD: all prior phases complete (9 suites / 131 tests green; wasm-drift guard in place). Master pushed at a3b34dc.
- `shared/src/contribution.ts`: STATUS_*, DIMENSIONS, paymentFor (C_1 → buildingBounty × match; C_2 → recordingBaseCredit × match; else 0), dimensionDeltaFor (= match), StepDef/DimensionSchema, SCHEMA_VERSION 'v2' + legacy, schemaForRecord, stepPaymentsFor.
- `shared/src/round.ts`: RoundEntry {contributionId, submitter, dims} + isValidRoundEntry, roundRctTotals(entries, alphaFor) (Σ alpha×match per submitter), AGGREGATE_ENTRY_LIMIT.
- Verify handler (`makeVerifyContributionHandler`): guards then per-check credit + accuracy total + recip add → counter bump → reject (status 2 + record) → pass+final: payments (payments Map; submitter only), tallies (paymentFor>0 dims; delta = dimensionDeltaFor + current), advance-or-accept, explanation record (includes `payments`).
- `complete_round` handler: validates entries (isValidRoundEntry, unique/exists/round-stamp/status=1) then `roundRctTotals(entries, alphaFor||1)`, cumulative rct: writes, publish record.
- Types: VerifyContributionPayload {contributionId, submitter, dims, stepId, pass, reason, schemaVersion?, priorVerifiers?}; SettleContributionPayload {..., verifiers?}.
- UI: onVerifyContribution (confirm/prompt, priorVerifiers from entry.verifiedBy); onCompleteRound collects entries from accepted+current-round mirror entries (maps {contributionId, submitter, dims}); contribution card receipts.
- Test helpers: contribution.test.ts (setupSubmitted/verifyOp/submitOp, run() cast, allSetElements; MockState getRegister→number|undefined), handlers.test.ts (0-default mock), crabs.test.ts (real wasm, buildSignedMemberOp), wizard.test.ts.

---

### Task 1: Harm constants, helpers, and RoundEntry harm

**Files:**
- Modify: `shared/src/contribution.ts` (constants + helpers)
- Modify: `shared/src/round.ts` (RoundEntry.harm + validation)
- Test: `server/test/round.test.ts` (+ harm block), `server/test/contribution.test.ts` (helper asserts optional)

- [ ] **Step 1: Failing tests** — append to `server/test/round.test.ts`:

```typescript
import { HARM_REDUCE_FACTOR, harmFactorFor, strongestHarm, type HarmVerdict } from '../../shared/src/contribution';

describe('harm adjustments (constants + helpers)', () => {
  it('reduced factor is the 0.5 pilot constant', () => {
    expect(HARM_REDUCE_FACTOR).toBe(0.5);
    expect(harmFactorFor(undefined)).toBe(1);
    expect(harmFactorFor('none')).toBe(1);
    expect(harmFactorFor('reduced')).toBe(0.5);
    expect(harmFactorFor('voided')).toBe(0);
    expect(() => harmFactorFor('kind-of' as unknown as HarmVerdict)).toThrow(); // invalid verdicts rejected at validation, never defaulted
  });

  it('strongest-wins: voided > reduced > none', () => {
    expect(strongestHarm(undefined, undefined)).toBe('none');
    expect(strongestHarm('reduced', undefined)).toBe('reduced');
    expect(strongestHarm(undefined, 'reduced')).toBe('reduced');
    expect(strongestHarm('reduced', 'voided')).toBe('voided');
    expect(strongestHarm('voided', 'reduced')).toBe('voided');
    expect(strongestHarm('none', 'none')).toBe('none');
  });
});
```

and a RoundEntry-harm validation case (inside the existing isValidRoundEntry describe or a new one):

```typescript
describe('RoundEntry harm validation', () => {
  it('accepts entries with valid harm; rejects invalid or wrong-typed harm', () => {
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'reduced' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'none' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'voided' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'kind-of' })).toBe(false);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 2 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL (exports missing).

- [ ] **Step 3: Implement** — in `shared/src/contribution.ts`:

```typescript
// Harm verdicts ride in the verify payload (page: "verified harm reduces/voids
// the outcome beforehand"). 'reduced' halves the outcome; 'voided' zeroes it —
// status still accepted (the work was real), zero payment/zero tally.
export type HarmVerdict = 'none' | 'reduced' | 'voided';

export const HARM_REDUCE_FACTOR = 0.5 as const;

export function isValidHarm(harm: unknown): harm is HarmVerdict | undefined {
  return harm === undefined || harm === 'none' || harm === 'reduced' || harm === 'voided';
}

export function harmFactorFor(harm: HarmVerdict | undefined): number {
  if (!isValidHarm(harm) || harm === undefined) throw new Error(`invalid harm verdict: ${harm as string}`);
  if (harm === 'reduced') return HARM_REDUCE_FACTOR;
  if (harm === 'voided') return 0;
  return 1;
}

// Conservative two-verifier rule: a harm verdict survives only as the
// strongest of the step's verdicts (voided > reduced > none).
export function strongestHarm(a: HarmVerdict | undefined, b: HarmVerdict | undefined): HarmVerdict {
  if (!isValidHarm(a) || !isValidHarm(b)) throw new Error('invalid harm verdict');
  const rank = { voided: 2, reduced: 1, none: 0 } as const;
  const first = a ?? 'none';
  const second = b ?? 'none';
  return rank[first] >= rank[second] ? first : second;
}
```

In `shared/src/round.ts` — `RoundEntry` gains `harm?: HarmVerdict` (import HarmVerdict from './contribution'); `isValidRoundEntry` adds `isValidHarm(e.harm)` to its return conjunction (invalid values → false).

- [ ] **Step 4: Run** both suites PASS; full `npm test` PASS (9 suites, everything green).
- [ ] **Step 5: Commit**

```bash
git add shared/src/contribution.ts shared/src/round.ts server/test/round.test.ts
git commit -m "feat: harm verdict helpers — factor, strongest-wins, entry validation"
```

---

### Task 2: Verify handler — harm-aware payment

**Files:**
- Modify: `shared/src/types.ts` (VerifyContributionPayload gains `harm?` + `priorHarm?`)
- Modify: `shared/src/handlers.ts` (verify handler)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Types** — VerifyContributionPayload gains:

```typescript
  harm?: HarmVerdict;     // this check's harm verdict (absent = none)
  priorHarm?: HarmVerdict; // client-attested verdict of the earlier check in this step (all-parties flows)
```

(import HarmVerdict from './contribution'; comment points at the design doc.)

- [ ] **Step 2: Failing tests** — append to `server/test/contribution.test.ts`:

```typescript
describe('verify harm adjustments', () => {
  it('reduced halves the bounty and the tally deltas', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-harm1', { '1': 1, '2': 0.5 });
    const verify = makeVerifyContributionHandler(node);
    // Note: single-verify dims (C_2 present) — one verify finalizes a default... C_1 wired → 2 verify steps. Use TWO verifies:
    expect(verify(state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-harm1', dims: { '1': 1, '2': 0.5 }, harm: 'reduced' })))).toBe(0);
    expect(verify(state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-harm1', dims: { '1': 1, '2': 0.5 }, priorHarm: 'reduced' })))).toBe(0);
    const expected = (RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5) * HARM_REDUCE_FACTOR;
    expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(expected);
    expect(state.getRegister('dim:alice:c1')).toBe(0.5);      // delta × 0.5
    expect(state.getRegister('dim:alice:c2')).toBe(0.25);     // 0.5 × 0.5
    expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit); // verifier credit NOT adjusted
    const records = state.allSetElements(CONTRIB_NAMES.explanations('c-harm1'));
    const finalRecord = JSON.parse(records.find((e: string) => e.includes('"payments"') && !e.includes('"payments":{}')) ?? '{}');
    expect(finalRecord.harm).toBe('reduced');
  });

  it('voided zeroes payment and tally; status still accepted', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-harm2', { '2': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ harm: 'voided' })))).toBe(0);
    expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(0);
    expect(state.getRegister('dim:alice:c2')).toBeUndefined(); // no tally register created for a voided delta
    expect(state.getRegister(CONTRIB_NAMES.status('c-harm2'))).toBe(1);
    expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit);
  });

  it('invalid harm strings are rejected outright', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-harm3', { '2': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ harm: 'kind-of' as never })))).toBe(-1);
    expect(state.getRegister(CONTRIB_NAMES.status('c-harm3'))).toBe(0); // untouched
  });
});
```

(Adapt helpers: if 'carol' isn't among the setupMembers in setupSubmitted — it adds signer + 'bob' only; extend per the file's current helper.)

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — in `makeVerifyContributionHandler`:
  - Validation block: `!isValidHarm(payload.harm) || !isValidHarm(payload.priorHarm)` → -1 (with the other payload guards).
  - In the pass+final payments/tally block — FIRST compute the effective verdict (BEFORE any write so voided/reduced never pay partially on a mid-flight error):

```typescript
      const effectiveHarm = strongestHarm(payload.priorHarm, payload.harm);
      const harmFactor = harmFactorFor(effectiveHarm);
```

  Then multiply: bounty amount `× harmFactor` (skip when ≤ 0 — existing guard), tally delta `dimensionDeltaFor(dimIndex, match) × harmFactor` (the tally-guard: `paymentFor(...) <= 0 continue` — NOTE the existing guard skips dims with no payment rule BEFORE the factor: keep that order — harm never creates a tally register for a zero-paid dim).
  Explanation record: `harm: effectiveHarm` (include in ALL final-acceptance records; also on reject-path? Rejections carry no payments — include `harm` too for completeness).
  - Also: the existing verify test 'on pass at the final requirement' (no harm) must stay green (absent harm = 'none' = factor 1 — but watch the no-payout C_9 tally guard: unchanged).

- [ ] **Step 5: Run full suite PASS.** Commit:

```bash
git add shared/src/types.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: verify verdicts apply harm before payment — reduced halves, voided zeroes"
```

---

### Task 3: Aggregation mirror — complete_round applies the entry harm

**Files:**
- Modify: `shared/src/handlers.ts` (complete_round)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Failing tests** — append:

```typescript
describe('complete_round harm mirror', () => {
  it('roundRctTotals entries carry harm; totals × factor; voided entries contribute 0', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state, 'r-harm1'); // two-verifier C_1 accepted + spine ready (adapt to the v2 helper's actual signature)
    const complete = makeCompleteRoundHandler(node);
    expect(complete(state, makeOp('complete_round', 'closer', {
      entries: [{ contributionId: 'r-harm1', submitter: 'alice', dims: { '1': 1 }, harm: 'reduced' }],
    } as CompleteRoundPayload))).toBe(0);
    // RCT mirrors the verified adjustment: alpha default 1 × match 1 × 0.5
    expect(state.getRegister(RCT_NAMES.balance('alice'))).toBe(0.5);
  });

  it('voided entries contribute 0 and are still valid entries', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state, 'r-harm2');
    const complete = makeCompleteRoundHandler(node);
    expect(complete(state, makeOp('complete_round', 'closer', {
      entries: [{ contributionId: 'r-harm2', submitter: 'alice', dims: { '1': 1 }, harm: 'voided' }],
    } as CompleteRoundPayload))).toBe(0);
    expect(state.getRegister(RCT_NAMES.balance('alice'))).toBe(0);
  });
});
```

(Read `setupSpineReady`'s current signature/flow first and adapt — it now runs the two-verifier C_1 under v2. Where its members/verifiers live, adjust the harm tests to use fresh ids 'r-harm1'/'r-harm2' with the SAME members.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — in `makeCompleteRoundHandler`:

```typescript
    const alphaFor = (i: number) => state.getRegister(CALIBRATIONS.alpha(i)) || 1;
    const totals = roundRctTotals(payload.entries.map(
      (entry) => ({
        contributionId: entry.contributionId,
        submitter: entry.submitter,
        dims: entry.dims,
        harm: entry.harm ?? 'none' as const,
      })
    ), (i) => {
      const base = alphaFor(i);
      // per-entry harm is applied per SUBMITTER SUM — roundRctTotals sums per
      // submitter, so apply the harm at ENTRY level here:
      return base;
    });
```

STOP — that mapping is wrong (roundRctTotals has no per-entry hook). Correct implementation WITHOUT changing roundRctTotals' signature: compute the totals with a harm-scaled dims map per entry:

```typescript
    const harmAdjusted = payload.entries.map((entry) => {
      const factor = harmFactorFor(entry.harm ?? 'none');
      const dims: Record<string, number> = {};
      for (const [k, v] of Object.entries(entry.dims)) dims[k] = v * factor;
      return { contributionId: entry.contributionId, submitter: entry.submitter, dims };
    });
    const totals = roundRctTotals(harmAdjusted, alphaFor);
```

(dims values scale linearly; the entry validation already gated harm's validity via isValidRoundEntry. Zero-dims entries (voided) → contribute nothing per-submitter but still count toward entryCount in the publish record.)

- [ ] **Step 4: Run full suite PASS.** Commit:

```bash
git add shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: complete_round mirrors harm in aggregated RCT totals"
```

---

### Task 4: Real-wasm harm test

**Files:**
- Test: `server/test/crabs.test.ts`

- [ ] **Step 1: Test first (it may pass already — this pins the wasm path)** — append (following the file's helpers; if it passes on first run, commit as a pin, noting that):

```typescript
it('harm-adjusted lifecycle through the real wasm node', async () => {
  const dao = new DaoNode();
  await dao.init();
  // members alice/bob/carol; calibration pre-set (v1 bootstrap).
  // alice submits 'r-harm-w1' dims {'1': 1} schemaVersion 'v2'.
  // bob verifies accepted harm 'reduced' (payload harm field).
  // carol verifies accepted priorHarm 'reduced'.
  // alice settles (verifiers ['bob','carol']).
  // asserts:
  expect(dao.getResBalance('alice')).toBe(6);   // buildingBounty 12 × 0.5
  expect(dao.getResBalance('bob')).toBe(2);     // verifier credit unadjusted
  expect(dao.getDimensionBalance('alice', 1)).toBe(0.5);
  expect(dao.getContributionStatus('r-harm-w1')).toBe('accepted');
});
```

- [ ] **Step 2: Run** full suite PASS (9 suites, expect ~135). Commit:

```bash
git add server/test/crabs.test.ts
git commit -m "test: harm-adjusted lifecycle pinned through real wasm"
```

---

### Task 5: Client wiring + harm UI

**Files:**
- Modify: `client/src/dao.ts` (mirror carries harm)
- Modify: `client/src/ui.ts` (verify dialog + receipts + complete-round collection)
- Modify: `client/src/theme.css` (harm pill/receipt classes if needed)
- Verify: tsc delta 0 + vite build + jest green + manual browser flow

- [ ] **Step 1: Mirror (client/src/dao.ts):** `ContributionMirrorEntry` gains `harm?: 'none' | 'reduced' | 'voided';` — the verify branch sets `entry.harm = payload.harm ?? 'none'` (and keeps verifiedBy/verdict as-is).

- [ ] **Step 2: Verify dialog (client/src/ui.ts, onVerifyContribution):** replace the single `confirm('Accept…?')` with:

```typescript
    const choice = prompt('Accept this contribution? Type: yes / yes-harm (reduced) / voided / no. (Cancel = nothing)');
    if (choice === null) return;
    const normalized = choice.trim().toLowerCase();
    let pass = false;
    let harm: 'none' | 'reduced' | 'voided' = 'none';
    if (normalized === 'yes' || normalized === 'y') { pass = true; }
    else if (normalized === 'yes-harm' || normalized === 'reduced') { pass = true; harm = 'reduced'; }
    else if (normalized === 'voided') { pass = true; harm = 'voided'; }
    else if (normalized === 'no' || normalized === 'n') { pass = false; }
    else {
      this.setStatus('Answer with yes / yes-harm / voided / no.', 'error');
      return;
    }
```

then include `harm` and — when `entry.verifiedBy` exists — `priorHarm: entry.harm` in the verify payload (the completing check carries the prior verdict; priorVerifiers already sent). Reason prompt unchanged.

- [ ] **Step 3: Receipts (buildContributionCard):** for accepted cards where mirror `entry.harm` is set: show `accepted — bounty X → Y (harm ${entry.harm})` style receipt (compute via paymentFor of the record dims × harmFactorFor — import from shared); voided cards: `accepted — outcome voided (harm)`.

- [ ] **Step 4: complete-round collection (onCompleteRound):** the entry mapping gains `harm: entry.harm ?? 'none'`.

- [ ] **Step 5: Gates:** tsc delta 0 (331 baseline); `npm run build:client`; `npm test` 9 suites green. Manual browser (WAVEDB_PATH=/tmp/dao-harm-fresh fresh):
  1. alice C_1 submission → bob accepts with reduced → carol completes (prior verdict carried) → alice settles → receipt shows the halved bounty; tally/RCT halved on the round publish.
  2. voided path: a C_2 submission → bob accepts voided → receipt shows voided; balances unchanged; round publish adds 0.
  3. invalid answer (`'maybe'`) → rejected with the error status, no op submitted.
- [ ] **Step 6: Commit:**

```bash
git add client/src/dao.ts client/src/ui.ts client/src/theme.css
git commit -m "feat(ui): three-choice harm verify flow with adjusted receipts"
```

---

### Task 6: e2e + hydration + docs

**Files:**
- Modify: `server/test/hydration.test.ts` (harm-bearing lifecycle survives replay)
- Modify: `test-voting-browser.js` (harm path in the 3-page flow)
- Modify: `docs/contribution-economy/README.md` (binding paragraph)

- [ ] **Step 1: Hydration test** — append: the harm-adjusted lifecycle (submit → bob verify reduced → carol priorHarm → settle) persisted + replayed; asserts `getResBalance`/`getDimensionBalance` keep the FACTOR in their values (6 / 0.5-style), status accepted. Fix the implementer's typo risk: `priorHarm` spelled correctly throughout.

- [ ] **Step 2: e2e** — extend `test-voting-browser.js`: the verify dialogs arm a `yes-harm` answer for one contribution (dialog-armed prompt text per script conventions); assert the receipt string appears; the spine/aggregation asserts keep passing (the round publish receipts now show harm-adjusted totals where applicable). Run fresh (WAVEDB_PATH=/tmp/dao-harm-e2e): report exactly.

- [ ] **Step 3: Docs** — extend `docs/contribution-economy/README.md`'s binding section:

```markdown
- Harm (2026-10-09): the delta formula's last term — verify verdicts carry
  `harm: none|reduced|voided` (reduced = fixed pilot factor 0.5); the factor
  applies to the submitter bounty and dimension deltas before payment (the
  verifier's per-check credit is never adjusted; voided = accepted with zero
  outcome); two-verifier flows use strongest-wins via the prior-check verdict
  (payload field `priorHarm`); `complete_round` mirrors the factor so
  published RCT matches adjusted tallies. Retroactive harm is inexpressible
  (balances never go negative) — the page's pre-payment rule stands.
```

- [ ] **Step 4: Commit**

```bash
git add server/test/hydration.test.ts test-voting-browser.js docs/contribution-economy/README.md
git commit -m "test/docs: harm lifecycle coverage + binding docs"
```

---

## Self-review

- **Spec coverage:** constants/helpers/entry validation (Task 1), verdict-aware payment with strongest-wins (Task 2), aggregation mirror (Task 3), wasm pin (Task 4), mirror+dialog+receipts (Task 5), tests + docs (Task 6). Verifier credit unadjusted — asserted in Tasks 2 and 4. No new ops/registers — nothing wired in crabs.ts/dao.ts beyond the mirror field (correct per spec).
- **Placeholder scan:** Task 3's STOP-block shows the WRONG draft then the correct implementation — the correct one is the only code to use (labeled; fine). No TBDs.
- **Type consistency:** HarmVerdict/harmFactorFor/strongestHarm/isValidHarm defined in Task 1, consumed in 2/3/5. RoundEntry.harm validated by isValidRoundEntry (Task 1) and enforced in complete_round's existing entry loop (which already calls isValidRoundEntry — the harm field rides the same gate ✓ no separate check needed in Task 3). UI imports paymentFor + harmFactorFor for receipts.
- **Note for execution:** Task 2 Step 2's first test asserts the tally `dim:alice:c1` = 0.5 for a reduced C_1 — read the CURRENT tally-writing guard carefully: tallies only create for paymentFor>0 dims AFTER the factor multiplies — a reduced-but-nonzero creates the register ✓; voided → factor 0 → skip (guard `paymentFor > 0` fires BEFORE the delta add — the spec test expects the register ABSENT (undefined) for voided: ensure the guard stays in that order).