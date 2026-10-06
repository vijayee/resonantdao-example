# Round Spine, $RCT Aggregation & Salient Voting Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement phase 2 per `docs/superpowers/specs/2026-10-06-round-spine-rct-aggregation-design.md` — the human-driven round spine (`audit_round`/`reckon_round`/`complete_round`), payload-driven $RCT aggregation published to `rct:{user}` registers, custodian calibration ops, and salient-dimension-derived quadratic voting balance (vote mechanics otherwise unchanged).

**Architecture:** Round state lives in CRABS registers (`round:current`, `round:{n}:stage`, `round:{n}:e` explanation ORSet), stamped on contributions (`contrib:{id}:round`) and proposals (`proposals:{id}:salient` bitmask). Aggregation is payload-driven: the client collects the round's settled-accepted contributions; the handler validates and recomputes deterministically from payload bytes (same replica-convergence model as verification). Voting keeps the existing quadratic cost machinery — only the gating balance changes to `derivedVoteBalance(mask, alpha, tallies, base, cap)` computed in-handler from registers. `$RES` no longer gates votes (its earned/transferable role is untouched); `$RCT` is publish-only.

**Tech Stack:** TypeScript, crabs-wasm (CRABS), WaveDB, Vite/esbuild client, Jest, Playwright e2e.

---

## Baseline and known-wasm truths (assume at execution start)

- HEAD: phase-1 + wizard plans fully implemented (7 suites / 79 tests, all green; final review READY_TO_CLOSE).
- Real wasm: `state.setRegister` on an undeclared resource throws `resource_not_found` — handlers MUST declare (via the injected `node.addRegister/addORSet/addPNCounter`) before every write; `node.getRegister('undeclared')` returns 0; `Node.addRegister(name, initial)` initial persists and re-declare throws `duplicate_operation` without resetting.
- Handlers cannot enumerate ORSets; anything not derivable from op payload bytes + registers is payload-attested (documented PoC trust model).
- Test conventions: `server/test/handlers.test.ts` (MockNode/MockState/makeOp, `initUser` seeds `res:`), `server/test/contribution.test.ts` (own MockState with `getRegister: number | undefined`, `setupMembers`/`submitOp`/`verifyOp`/`setupSubmitted`, `allSetElements` on MockState), `server/test/crabs.test.ts` (real wasm + `buildSignedMemberOp` helper using `dao.getUserKeyVersion`).
- CRABS policy enforcement: op types without a registered policy throw `unauthorized` at execute. Register both policy AND handler for every new op type on DaoNode AND BrowserDao.
- CRABS key limit is 63 chars: `round:{n}` is small; `contrib:{uuid}:round` = 8+36+6 = 50 ✓; `proposals:{uuid}:salient` = 10+36+8 = 54 ✓.

---

### Task 1: Round registry module (`shared/src/round.ts`)

**Files:**
- Create: `shared/src/round.ts`
- Modify: `shared/src/policies.ts` (ROUND_NAMES, RCT_NAMES, CALIBRATIONS names; salient register name in TOKEN_NAMES; `contrib:{id}:round` in CONTRIB_NAMES)
- Create: `server/test/round.test.ts`

- [ ] **Step 1: Write the failing test** — create `server/test/round.test.ts` (pure functions; no mocks needed):

```typescript
import {
  STAGE_OPEN, STAGE_AUDITED, STAGE_RECKONED, STAGE_PUBLISHED,
  encodeSalientMask, decodeSalientMask,
  roundRctTotals, derivedVoteBalance,
  CALIBRATION_VERSIONS, CALIBRATION_VERSION_NUMBERS,
  isValidRoundEntry, AGGREGATE_ENTRY_LIMIT,
} from '../../shared/src/round';

describe('round registry', () => {
  it('stage constants are 0..3', () => {
    expect(STAGE_OPEN).toBe(0);
    expect(STAGE_AUDITED).toBe(1);
    expect(STAGE_RECKONED).toBe(2);
    expect(STAGE_PUBLISHED).toBe(3);
  });

  describe('salient mask', () => {
    it('encodes/decodes a subset of dimensions 0..21', () => {
      const mask = encodeSalientMask([1, 18]);
      expect(mask).toBe((1 << 1) | (1 << 18));
      expect(decodeSalientMask(mask)).toEqual([1, 18]);
    });
    it('empty list encodes 0 (base-membership-only question)', () => {
      expect(encodeSalientMask([])).toBe(0);
      expect(decodeSalientMask(0)).toEqual([]);
    });
    it('rejects out-of-range and duplicate dims', () => {
      expect(() => encodeSalientMask([22])).toThrow();
      expect(() => encodeSalientMask([-1])).toThrow();
      expect(() => encodeSalientMask([1, 1])).toThrow();
      expect(() => encodeSalientMask([1.5] as unknown as number[])).toThrow();
    });
  });

  describe('roundRctTotals', () => {
    const alphaFor = (i: number) => (i === 1 ? 2 : 1);
    it('aggregates per submitter over entries; unscored dims contribute nothing', () => {
      const totals = roundRctTotals([
        { contributionId: 'a', submitter: 'alice', dims: { '1': 1, '9': 1 } },
        { contributionId: 'b', submitter: 'alice', dims: { '2': 0.5 } },
        { contributionId: 'c', submitter: 'bob', dims: { '2': 1 } },
      ], alphaFor);
      expect(totals.get('alice')).toBe(2 * 1 + 1 * 1 + 1 * 0.5); // 3.5 — dim 9 has no tally input by construction (caller filters); alpha defaulting is the caller's concern
      expect(totals.get('bob')).toBe(1);
    });
    it('returns an empty map for no entries', () => {
      expect(roundRctTotals([], alphaFor).size).toBe(0);
    });
  });

  describe('derivedVoteBalance', () => {
    const tally = (i: number) => (i === 1 ? 10 : i === 2 ? 0.5 : 0);
    const alpha = (i: number) => (i === 1 ? 2 : 1);
    it('base plus masked salient contributions', () => {
      expect(derivedVoteBalance(encodeSalientMask([1]), (i) => alpha(i), tally, 3, 50)).toBe(3 + 2 * 10);
      expect(derivedVoteBalance(encodeSalientMask([1, 2]), (i) => alpha(i), tally, 3, 50)).toBe(3 + 2 * 10 + 0.5);
      expect(derivedVoteBalance(0, (i) => alpha(i), tally, 3, 50)).toBe(3); // base-only (elections, no salience)
    });
    it('caps the derived balance', () => {
      expect(derivedVoteBalance(encodeSalientMask([1]), (i) => alpha(i), tally, 3, 10)).toBe(10);
    });
  });

  it('calibration versions map v1 <-> 1', () => {
    expect(CALIBRATION_VERSIONS).toEqual(['v1']);
    expect(CALIBRATION_VERSION_NUMBERS.get('v1')).toBe(1);
  });

  describe('isValidRoundEntry', () => {
    it('accepts well-formed entries and rejects broken ones', () => {
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'alice', dims: { '1': 1 } })).toBe(true);
      expect(isValidRoundEntry({ contributionId: '', submitter: 'alice', dims: { '1': 1 } })).toBe(false);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: '', dims: { '1': 1 } })).toBe(false);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: {} })).toBe(false);
      expect(isValidRoundEntry(null)).toBe(false);
      expect(AGGREGATE_ENTRY_LIMIT).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test -- round.test.ts` (module missing).

- [ ] **Step 3: Implement** — create `shared/src/round.ts`:

```typescript
import { DIMENSION_COUNT, isValidDims } from './contribution';

// Round spine stages (C_10 audit → C_20 reckon → C_21 complete/publish).
export const STAGE_OPEN = 0 as const;
export const STAGE_AUDITED = 1 as const;
export const STAGE_RECKONED = 2 as const;
export const STAGE_PUBLISHED = 3 as const;

// Justice-calibration versions (page: "Judgement cannot finalize a cycle
// without a current Justice calibration"). 'v1' is the pilot's only version;
// registration stores the numeric index.
export const CALIBRATION_VERSIONS = ['v1'] as const;
export const CALIBRATION_VERSION_NUMBERS = new Map<string, number>(
  CALIBRATION_VERSIONS.map((v, i) => [v, i + 1])
);

export const AGGREGATE_ENTRY_LIMIT = 200 as const;

export interface RoundEntry {
  contributionId: string;
  submitter: string;
  dims: Record<string, number>;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function isValidRoundEntry(entry: unknown): entry is RoundEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Partial<RoundEntry>;
  return isNonEmptyString(e.contributionId) && isNonEmptyString(e.submitter) && isValidDims(e.dims);
}

export function encodeSalientMask(dims: number[]): number {
  if (!Array.isArray(dims)) throw new Error('salient dims must be an array');
  const seen = new Set<number>();
  for (const d of dims) {
    if (!Number.isInteger(d) || d < 0 || d >= DIMENSION_COUNT) {
      throw new Error(`invalid salient dimension: ${d}`);
    }
    if (seen.has(d)) throw new Error(`duplicate salient dimension: ${d}`);
    seen.add(d);
  }
  let mask = 0;
  for (const d of seen) mask |= 1 << d;
  return mask;
}

export function decodeSalientMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < DIMENSION_COUNT; i++) {
    if ((mask & (1 << i)) !== 0) out.push(i);
  }
  return out;
}

// Aggregate a round's settled contributions into per-submitter totals.
// The caller decides alpha semantics (default weight handling happens there).
export function roundRctTotals(
  entries: RoundEntry[],
  alphaFor: (dimIndex: number) => number
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    let sum = totals.get(entry.submitter) ?? 0;
    for (const [dimKey, match] of Object.entries(entry.dims)) {
      sum += alphaFor(Number(dimKey)) * match;
    }
    totals.set(entry.submitter, sum);
  }
  return totals;
}

// Pilot voting model: base membership + bounded multiplier from salient
// balances, capped; the pre-existing quadratic cost machinery consumes this
// balance. Unscored (unscored-dimension) members simply contribute base.
export function derivedVoteBalance(
  salientMask: number,
  alphaFor: (dimIndex: number) => number,
  tallyFor: (dimIndex: number) => number,
  base: number,
  cap: number
): number {
  let balance = base;
  for (let i = 0; i < DIMENSION_COUNT; i++) {
    if ((salientMask & (1 << i)) === 0) continue;
    balance += alphaFor(i) * tallyFor(i);
  }
  return balance > cap ? cap : balance;
}
```

Modify `shared/src/policies.ts` — add to `CONTRIB_NAMES`:

```typescript
  // Round a contribution belongs to (stamped by the submit handler).
  contributionRound: (contributionId: string) => `contrib:${contributionId}:round`,
```

Add after `CONTRIB_NAMES` (or after `RES_NAMES`):

```typescript
export const ROUND_NAMES = {
  current: () => 'round:current',
  stage: (round: number) => `round:${round}:stage`,
  // One JSON explanation record per spine op, element-tagged `${stepId}:${signer}`.
  explanations: (round: number) => `round:${round}:e`,
} as const;

export const RCT_NAMES = {
  balance: (username: string) => `rct:${username}`,
} as const;

export const CALIBRATIONS = {
  alpha: (dimIndex: number) => `config:alpha:${dimIndex}`,
  alphaVersion: () => 'config:alpha_ver',
  calibrationVersion: () => 'config:calibration_version',
  voteBase: () => 'config:vote_base',
  voteCap: () => 'config:weight_cap',
} as const;
```

Add to `TOKEN_NAMES` (stays in policies.ts with the proposal resources):

```typescript
  proposalSalient: (proposalId: string) => `proposals:${proposalId}:salient`,
```

- [ ] **Step 4: Run** `npm test -- round.test.ts` → PASS; full `npm test` → PASS (no existing behavior changed).
- [ ] **Step 5: Commit**

```bash
git add shared/src/round.ts shared/src/policies.ts server/test/round.test.ts
git commit -m "feat: round spine registry, salient masks, and pilot vote-balance math"
```

---

### Task 2: Custodian calibration ops (`set_rct_alpha`, `set_calibration_version`)

**Files:**
- Modify: `shared/src/types.ts` (new payloads)
- Modify: `shared/src/policies.ts` (two policies)
- Modify: `shared/src/handlers.ts` (two handlers)
- Test: `server/test/contribution.test.ts` (append a "calibration ops" block)

- [ ] **Step 1: Types** — add to `shared/src/types.ts`:

```typescript
export interface SetRctAlphaPayload {
  weights: Record<string, number>; // sparse: dimension index -> alpha in (0, 10]
  version: string;                 // alpha version label, recorded in the explanation record
}

export interface SetCalibrationVersionPayload {
  version: string; // must be a known calibration version ('v1' in phase 2)
}
```

- [ ] **Step 2: Policies** — add to `POLICIES`:

```typescript
  set_rct_alpha: 'role:custodian',
  set_calibration_version: 'role:custodian',
```

- [ ] **Step 3: Tests first (red)** — append to `server/test/contribution.test.ts` (reuse MockNode/MockState/makeOp; note MockState.getRegister returns `number | undefined`):

```typescript
import {
  makeSetRctAlphaHandler, makeSetCalibrationVersionHandler,
} from '../../shared/src/handlers';
import { CALIBRATIONS, RCT_NAMES } from '../../shared/src/policies';
import { SetRctAlphaPayload, SetCalibrationVersionPayload } from '../../shared/src/types';

describe('calibration ops', () => {
  it('set_rct_alpha writes sparse weights and bumps alpha version', () => {
    const node = new MockNode();
    const state = new MockState(node);
    try { node.addRegister(CALIBRATIONS.alphaVersion(), 0); } catch { /* test-only */ }
    const handler = makeSetRctAlphaHandler(node);
    expect(handler(state, makeOp('set_rct_alpha', 'cust1', {
      weights: { '1': 2, '2': 0.5 }, version: 'alpha-2' } as SetRctAlphaPayload))).toBe(0);
    expect(state.getRegister(CALIBRATIONS.alpha(1))).toBe(2);
    expect(state.getRegister(CALIBRATIONS.alpha(2))).toBe(0.5);
    expect(state.getRegister(CALIBRATIONS.alphaVersion())).toBe(1); // first write bumps 0 -> 1
  });

  it('set_rct_alpha rejects invalid subsets and weights', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSetRctAlphaHandler(node);
    expect(handler(state, makeOp('set_rct_alpha', 'cust1', { weights: { '22': 1 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(handler(state, makeOp('set_rct_alpha', 'cust1', { weights: { '1': 0 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(handler(state, makeOp('set_rct_alpha', 'cust1', { weights: { '1': 11 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(handler(state, makeOp('set_rct_alpha', 'cust1', { weights: {}, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
  });

  it('set_calibration_version maps known version to its index', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSetCalibrationVersionHandler(node);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* pre-set in tasks after this */ }
    expect(handler(state, makeOp('set_calibration_version', 'cust1', { version: 'v1' } as SetCalibrationVersionPayload))).toBe(0);
    expect(state.getRegister(CALIBRATIONS.calibrationVersion())).toBe(1);
    expect(handler(state, makeOp('set_calibration_version', 'cust1', { version: 'v99' } as SetCalibrationVersionPayload))).toBe(-1);
  });
});
```

(May adjust the exact alpha-version bump semantics: simplest deterministic rule — read current version index, write `previous + 1`; test pins 0 → 1. Declare `alphaVersion` lazily in the handler with `try addRegister(name, 0) catch {}` BEFORE reading, so the tests above need no pre-declaration — if you choose that, drop the pre-declaration lines from the tests; handler declares both `alpha:{i}` and `alphaVersion`. MATCH the declaration-first discipline of every other handler.)

- [ ] **Step 4: Run** `npm test -- contribution.test.ts` → FAIL (handlers missing).

- [ ] **Step 5: Implement** — add to `shared/src/handlers.ts` (imports merge: `isValidDims` already present; `CALIBRATIONS` from './policies'; `CALIBRATION_VERSION_NUMBERS` from './round'; the payloads from './types'; `setOperationSignerKeyVersion` NOT needed — handlers are wasm-internal):

```typescript
export function makeSetRctAlphaHandler(
  node: { addRegister(name: string, initial?: number): void }
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SetRctAlphaPayload = JSON.parse(op.payload || '{}');
    if (payload.weights === null || typeof payload.weights !== 'object' || Array.isArray(payload.weights)) {
      return -1;
    }
    const entries = Object.entries(payload.weights as Record<string, unknown>);
    if (entries.length === 0 || !isNonEmptyString(payload.version) || payload.version.length > 64) {
      return -1;
    }
    for (const [key, value] of entries) {
      const dim = Number(key);
      const ok =
        Number.isInteger(dim) && dim >= 0 && dim < 22 && String(dim) === String(key) &&
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10;
      if (!ok) {
        return -1;
      }
    }
    // Declare before write (real wasm: setRegister throws resource_not_found).
    for (const [key] of entries) {
      try { node.addRegister(CALIBRATIONS.alpha(Number(key)), 0); } catch (err) { /* ignore duplicate */ }
    }
    const curAlphaVersion = state.getRegister(CALIBRATIONS.alphaVersion()) || 0;
    state.setRegister(CALIBRATIONS.alphaVersion(), curAlphaVersion + 1, op.signerId);
    for (const [key, value] of entries) {
      state.setRegister(CALIBRATIONS.alpha(Number(key)), value as number, op.signerId);
    }
    const explanation = {
      alphaVersion: curAlphaVersion + 1,
      version: payload.version,
      weights: payload.weights,
    };
    // Explanation record (weights changes are explainable + reproducible per
    // the page). Lives in the round-agnostic alpha explanation set.
    state.setAdd(STATE_NAMES.executedProposals, `alpha-explain:${curAlphaVersion + 1}`, JSON.stringify(explanation));
    return 0;
  };
}
```

WAIT — do NOT abuse `executedProposals` for alpha explanations. Instead create a dedicated ORSet at node init in the wiring task: add `ALPHA_EXPLANATIONS = 'config:alpha_explanations'` to `CALIBRATIONS` in policies.ts:

```typescript
  explanations: () => 'config:alpha_explanations',
```

and use `state.setAdd(CALIBRATIONS.explanations(), JSON.stringify(explanation), `alpha:${curAlphaVersion + 1}`)`. (Set creation happens in Task 6/7 wiring at node init; for the unit tests with MockNode it works without declaration — but pin that wiring covers it; note in the task.)

```typescript
export function makeSetCalibrationVersionHandler(
  node: { addRegister(name: string, initial?: number): void }
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SetCalibrationVersionPayload = JSON.parse(op.payload || '{}');
    const mapped = CALIBRATION_VERSION_NUMBERS.get(payload.version ?? '');
    if (!mapped) {
      return -1; // unknown calibration version
    }
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 0); } catch (err) { /* ignore duplicate */ }
    state.setRegister(CALIBRATIONS.calibrationVersion(), mapped, op.signerId);
    return 0;
  };
}
```

- [ ] **Step 6: Run** — `npm test -- contribution.test.ts` PASS; full `npm test` PASS.
- [ ] **Step 7: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: custodian calibration ops — set_rct_alpha and set_calibration_version"
```

---

### Task 3: Spine ops — `audit_round` and `reckon_round`

**Files:**
- Modify: `shared/src/types.ts` (payloads)
- Modify: `shared/src/policies.ts` (policies)
- Modify: `shared/src/handlers.ts` (handlers)
- Test: `server/test/contribution.test.ts` (append "round spine" block)

- [ ] **Step 1: Types** — add to `shared/src/types.ts`:

```typescript
export interface AuditRoundPayload {
  fair: boolean;
  note: string;
  calibrationVersion: string; // must match the current registered calibration (numeric map)
}

export interface ReckonRoundPayload {
  note: string;
}
```

Policies:

```typescript
  audit_round: 'role:member',
  reckon_round: 'role:member',
```

- [ ] **Step 2: Tests first (red)** — append to `server/test/contribution.test.ts`:

```typescript
import { makeAuditRoundHandler, makeReckonRoundHandler } from '../../shared/src/handlers';
import { ROUND_NAMES, CALIBRATIONS } from '../../shared/src/policies';
import { AuditRoundPayload, ReckonRoundPayload } from '../../shared/src/types';

function setupRound(node: MockNode, state: MockState, round = 1) {
  try { node.addRegister(ROUND_NAMES.current(), round); } catch { /* in tests the handler creates it */ }
  try { node.addRegister(ROUND_NAMES.stage(round), 0); } catch { /* ok */ }
}

describe('round spine: audit + reckon', () => {
  it('fair audit advances stage 0 -> 1 with an explanation record', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring pre-sets */ }
    const audit = makeAuditRoundHandler(node);
    expect(audit(state, makeOp('audit_round', 'alice', { fair: true, note: 'all good', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(1);
    const records = state.allSetElements(ROUND_NAMES.explanations(1));
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]).audit.fair).toBe(true);
  });

  it('unfair audit records the debt and completes the round WITHOUT aggregation', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
    const audit = makeAuditRoundHandler(node);
    expect(audit(state, makeOp('audit_round', 'alice', { fair: false, note: 'under-measured care work', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(3); // debt path: round completes with no publish
    expect(state.getRegister(ROUND_NAMES.current())).toBe(2); // next round begins
  });

  it('rejects audit with missing note, wrong calibration, or non-open stage', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    setupRound(node, state, 1);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
    const audit = makeAuditRoundHandler(node);
    expect(audit(state, makeOp('audit_round', 'alice', { fair: true, note: '', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(-1);
    expect(audit(state, makeOp('audit_round', 'alice', { fair: true, note: 'x', calibrationVersion: 'v9' } as AuditRoundPayload))).toBe(-1);
    expect(audit(state, makeOp('audit_round', 'nonmember', { fair: true, note: 'x', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(-1);
  });

  it('reckon requires the audited stage and a set calibration register', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    setupRound(node, state, 1);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
    const audit = makeAuditRoundHandler(node);
    const reckon = makeReckonRoundHandler(node);
    // Not audited yet:
    expect(reckon(state, makeOp('reckon_round', 'alice', { note: 'early' } as ReckonRoundPayload))).toBe(-1);
    expect(audit(state, makeOp('audit_round', 'alice', { fair: true, note: 'ok', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    expect(reckon(state, makeOp('reckon_round', 'alice', { note: 'records are settled' } as ReckonRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(2);
    expect(state.allSetElements(ROUND_NAMES.explanations(1))).toHaveLength(2);
  });

  it('reckon is rejected without a calibration register (Justice gate)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    setupRound(node, state, 1);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring pre-sets; remove this line to see the gate */ }
    const audit = makeAuditRoundHandler(node);
    const reckon = makeReckonRoundHandler(node);
    expect(audit(state, makeOp('audit_round', 'alice', { fair: true, note: 'ok', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    // Simulate unset calibration by direct register write (MockState):
    state.setRegister(CALIBRATIONS.calibrationVersion(), 0);
    expect(reckon(state, makeOp('reckon_round', 'alice', { note: 'x' } as ReckonRoundPayload))).toBe(-1);
  });
});
```

(If the file's `setupMembers` needs a different signature, adapt; `allSetElements` exists from the wizard task.)

- [ ] **Step 3: Run** `npm test -- contribution.test.ts` → FAIL.

- [ ] **Step 4: Implement** — add to `shared/src/handlers.ts` (imports merge: `ROUND_NAMES`, `CALIBRATIONS`, `STAGE_*` constants, `CALIBRATION_VERSION_NUMBERS` from './round'):

```typescript
export function makeAuditRoundHandler(
  node: { addORSet(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: AuditRoundPayload = JSON.parse(op.payload || '{}');
    if (
      typeof payload.fair !== 'boolean' ||
      !isNonEmptyString(payload.note) ||
      !isNonEmptyString(payload.calibrationVersion)
    ) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, op.signerId)) {
      return -1;
    }
    const round = state.getRegister(ROUND_NAMES.current()) || 1;
    if (state.getRegister(ROUND_NAMES.stage(round)) !== STAGE_OPEN) {
      return -1;
    }
    // Justice calibration: the audit must cite the currently registered
    // calibration version ('v1' maps to 1; unset register falls back to 'v1').
    const registered = state.getRegister(CALIBRATIONS.calibrationVersion()) || 1;
    if (CALIBRATION_VERSION_NUMBERS.get(payload.calibrationVersion) !== registered) {
      return -1;
    }

    try { node.addORSet(ROUND_NAMES.explanations(round)); } catch (err) { /* ignore duplicate */ }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = {
      stepId: 'audit',
      fair: payload.fair,
      note: payload.note,
      calibrationVersion: payload.calibrationVersion,
      at: nowMs,
    };
    state.setAdd(ROUND_NAMES.explanations(round), JSON.stringify(record), `audit:${op.signerId}`);
    if (payload.fair) {
      state.setRegister(ROUND_NAMES.stage(round), STAGE_AUDITED, op.signerId);
    } else {
      // Debt path: record stands as the round's debt; round completes with
      // NO aggregation and the next round begins (retry semantics).
      state.setRegister(ROUND_NAMES.stage(round), STAGE_PUBLISHED, op.signerId);
      state.setRegister(ROUND_NAMES.current(), round + 1, op.signerId);
    }
    return 0;
  };
}

export function makeReckonRoundHandler(
  node: { addORSet(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ReckonRoundPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.note)) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, op.signerId)) {
      return -1;
    }
    const round = state.getRegister(ROUND_NAMES.current()) || 1;
    if (state.getRegister(ROUND_NAMES.stage(round)) !== STAGE_AUDITED) {
      return -1;
    }
    // Justice gate: a current calibration must exist in CRABS.
    if ((state.getRegister(CALIBRATIONS.calibrationVersion()) || 0) < 1) {
      return -1;
    }

    try { node.addORSet(ROUND_NAMES.explanations(round)); } catch (err) { /* ignore duplicate */ }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = { stepId: 'reckon', note: payload.note, at: nowMs };
    state.setAdd(ROUND_NAMES.explanations(round), JSON.stringify(record), `reckon:${op.signerId}`);
    state.setRegister(ROUND_NAMES.stage(round), STAGE_RECKONED, op.signerId);
    return 0;
  };
}
```

Declaration-order discipline for the real wasm: the fairness/unfair paths write `ROUND_NAMES.stage(round)` — the register must be declared. The spine handlers declare it lazily on first use per round:

Add immediately after the stage check in BOTH handlers (before first stage write):

```typescript
    try { node.addRegister(ROUND_NAMES.stage(round), 0); } catch (err) { /* ignore duplicate */ }
```

IMPORTANT wasm-semantics note for the implementation: in the REAL Node, `addRegister(name, initial)` on an ALREADY-DECLARED register throws `duplicate_operation` WITHOUT resetting the value (pinned in server/test/crabs.test.ts), so lazy try-declare is safe. MockNode follows the same contract.

- [ ] **Step 5: Run** `npm test -- contribution.test.ts` PASS; full suite PASS.
- [ ] **Step 6: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: audit_round and reckon_round spine ops with Justice calibration gate"
```

---

### Task 4: `complete_round` — payload-driven aggregation + publication

**Files:**
- Modify: `shared/src/types.ts` (CompleteRoundPayload)
- Modify: `shared/src/policies.ts` (complete_round policy)
- Modify: `shared/src/handlers.ts` (handler)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Type** — add to `shared/src/types.ts` (import `RoundEntry` from './round'):

```typescript
export interface CompleteRoundPayload {
  entries: RoundEntry[]; // the round's settled+accepted contributions (client-collected)
}
```

Policy: `complete_round: 'role:member',`

- [ ] **Step 2: Tests first (red)** — append to `server/test/contribution.test.ts`:

```typescript
import { makeCompleteRoundHandler } from '../../shared/src/handlers';
import { STAGE_PUBLISHED, STAGE_AUDITED, STAGE_RECKONED } from '../../shared/src/round';
import { CompleteRoundPayload } from '../../shared/src/types';
import { RCT_NAMES, RES_NAMES } from '../../shared/src/policies';

function setupSpineReady(node: MockNode, state: MockState) {
  setupMembers(state, 'alice', 'bob', 'closer');
  setupSubmitted(state, node, 'alice', 'r1-a', { '1': 1 });
  const verify = makeVerifyContributionHandler(node);
  expect(verify(state, makeOp('verify_contribution', 'bob',
    verifyOp({ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 }, pass: true, reason: 'ok' })))).toBe(0);
  // settle alice's contribution to exit the 3-step schema cleanly
  const settle = makeSettleContributionHandler(node);
  expect(settle(state, makeOp('settle_contribution', 'alice',
    { contributionId: 'r1-a', submitter: 'alice', reason: 'done' } as SettleContributionPayload))).toBe(0);

  try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
  const audit = makeAuditRoundHandler(node, { getTimeMs: () => 0 });
  const reckon = makeReckonRoundHandler(node, { getTimeMs: () => 0 });
  expect(audit(state, makeOp('audit_round', 'closer2', { fair: true, note: 'ok', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
  expect(reckon(state, makeOp('reckon_round', 'closer2', { note: 'settled' } as ReckonRoundPayload))).toBe(0);
}

describe('complete_round', () => {
  it('publishes cumulative RCT totals and advances the round', () => {
    const node = new MockNode();
    const state = new MockState(node);
    try { node.addRegister(CALIBRATIONS.alpha(1), 2); } catch { /* wiring */ }
    setupSpineReady(node, state);

    const complete = makeCompleteRoundHandler(node);
    expect(complete(state, makeOp('complete_round', 'closer2', {
      entries: [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(3);
    expect(state.getRegister(ROUND_NAMES.current())).toBe(2);
    expect(state.getRegister(RCT_NAMES.balance('alice'))).toBe(2 * 1); // alpha(1)=2 × match 1
    const records = state.allSetElements(ROUND_NAMES.explanations(1));
    const publishRecord = JSON.parse(records.find((e) => e.includes('"published"')) ?? '{}');
    expect(publishRecord.stepId).toBe('complete');
    expect(publishRecord.entryCount).toBe(1);
    expect(publishRecord.totals['alice']).toBe(2);
    expect(publishRecord.alphaVersion).toBeDefined();
  });

  it('rejects entries that are unknown, duplicated, or not part of the round', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state);
    const complete = makeCompleteRoundHandler(node);
    expect(complete(state, makeOp('complete_round', 'closer2', {
      entries: [{ contributionId: 'ghost', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(-1);
    expect(complete(state, makeOp('complete_round', 'closer2', {
      entries: [
        { contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } },
        { contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } },
      ],
    } as CompleteRoundPayload))).toBe(-1);
  });

  it('rejects before stage 2 and after completion (stage must be RECKONED)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'closer');
    const complete = makeCompleteRoundHandler(node);
    expect(complete(state, makeOp('complete_round', 'closer', {
      entries: [],
    } as CompleteRoundPayload))).toBe(-1); // stage 0, and also empty entries
  });

  it('rejects empty entries list', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state);
    const complete = makeCompleteRoundHandler(node);
    expect(complete(state, makeOp('complete_round', 'closer2', {
      entries: [],
    } as CompleteRoundPayload))).toBe(-1);
  });
});
```

(The entry-limit test (>200 entries) is covered by `AGGREGATE_ENTRY_LIMIT` validation — add one inline assertion to the second rejection test if convenient. Keep the suite lean: the limit is unit-pinned via constant + one over-limit send if easy. Skip the over-limit fixture if constructing 201 entries is awkward with the helpers — pin the limit in the round.test.ts only.)

- [ ] **Step 3: Run** `npm test -- contribution.test.ts` → FAIL.

- [ ] **Step 4: Implement** — add to `shared/src/handlers.ts` (imports merge: `isValidRoundEntry`, `AGGREGATE_ENTRY_LIMIT`, `roundRctTotals`, `STAGE_PUBLISHED`, `STAGE_RECKONED` from './round'; `RCT_NAMES`, `ROUND_NAMES`, `CALIBRATIONS`, `STATE_NAMES` already imported):

```typescript
export function makeCompleteRoundHandler(
  node: { addRegister(name: string, initial?: number): void; addORSet(name: string): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: CompleteRoundPayload = JSON.parse(op.payload || '{}');
    if (
      !Array.isArray(payload.entries) ||
      payload.entries.length === 0 ||
      payload.entries.length > AGGREGATE_ENTRY_LIMIT
    ) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, op.signerId)) {
      return -1;
    }
    const round = state.getRegister(ROUND_NAMES.current()) || 1;
    if (state.getRegister(ROUND_NAMES.stage(round)) !== STAGE_RECKONED) {
      return -1;
    }
    for (const entry of payload.entries) {
      if (!isValidRoundEntry(entry)) {
        return -1;
      }
    }
    const seen = new Set<string>();
    for (const entry of payload.entries) {
      if (seen.has(entry.contributionId)) {
        return -1;
      }
      seen.add(entry.contributionId);
      if (!state.setContains(STATE_NAMES.contributions, entry.contributionId)) {
        return -1;
      }
      // Round-stamp validation: entries belong to the round being completed.
      if ((state.getRegister(CONTRIB_NAMES.contributionRound(entry.contributionId)) || 0) !== round) {
        return -1;
      }
      // Aggregation input = settled, accepted contributions only.
      if (state.getRegister(CONTRIB_NAMES.status(entry.contributionId)) !== 1) {
        return -1;
      }
    }

    const alphaFor = (i: number) => state.getRegister(CALIBRATIONS.alpha(i)) || 1;
    const totals = roundRctTotals(payload.entries, alphaFor);
    for (const [target, amount] of totals) {
      try { node.addRegister(RCT_NAMES.balance(target), 0); } catch (err) { /* exists */ }
      // Published RCT is CUMULATIVE through this round (tallies are cumulative;
      // alpha changes are forward-looking — see design doc).
      const prev = state.getRegister(RCT_NAMES.balance(target)) || 0;
      state.setRegister(RCT_NAMES.balance(target), prev + amount, op.signerId);
    }

    try { node.addORSet(ROUND_NAMES.explanations(round)); } catch (err) { /* wired at init; lazy here */ }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = {
      stepId: 'complete',
      round,
      entryCount: payload.entries.length,
      totals: Object.fromEntries(totals),
      alphaVersion: state.getRegister(CALIBRATIONS.alphaVersion()) || 1,
      calibrationVersion: state.getRegister(CALIBRATIONS.calibrationVersion()) || 1,
      at: nowMs,
    };
    state.setAdd(ROUND_NAMES.explanations(round), JSON.stringify(record), `complete:${op.signerId}`);
    state.setRegister(ROUND_NAMES.stage(round), STAGE_PUBLISHED, op.signerId);
    state.setRegister(ROUND_NAMES.current(), round + 1, op.signerId);
    return 0;
  };
}
```

Also — the round-stamp validation needs the submit handler to WRITE `CONTRIB_NAMES.contributionRound(id)`; that write is added in Task 5 Step 1. Until then, this test can't pass — add the write in this task instead (smaller blast radius, same commit): in `makeSubmitContributionHandler`, inside the lifecycle-init block right after the step-register declaration:

```typescript
    try { node.addRegister(CONTRIB_NAMES.contributionRound(payload.contributionId), round); } catch (err) { /* ignore duplicate */ }
```

with `const round = state.getRegister(ROUND_NAMES.current()) || 1;` read BEFORE the duplicate/exists checks reorder-safely (read after validation, before writes; if `round:current` is undeclared it reads 0 → fallback 1 — matches `|| 1` semantics used by spine handlers).

And extend one submit test to pin the stamp: in the lifecycle-init test add

```typescript
    expect(state.getRegister(CONTRIB_NAMES.contributionRound('c-1'))).toBe(1);
```

- [ ] **Step 5: Run** `npm test -- contribution.test.ts` PASS; full `npm test` PASS.
- [ ] **Step 6: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: complete_round publishes aggregated RCT and advances the round"
```

---

### Task 5: Salient proposals — create_proposal mask + vote balance switch

**Files:**
- Modify: `shared/src/types.ts` (ProposalPayload gains `salientDims?: number[]`)
- Modify: `shared/src/handlers.ts` (create_proposal writes mask; vote/runoff handlers compute derived balance)
- Test: `server/test/handlers.test.ts`

- [ ] **Step 1: Types** — `ProposalPayload` gains:

```typescript
  salientDims?: number[]; // question-declared salient dimensions (0..21, unique); absent = base-only
```

- [ ] **Step 2: Tests first (red)** — append to `server/test/handlers.test.ts` (reusing its helpers; NOTE: this file's `initUser` funds `res:` — the vote NO LONGER reads it, so funding-style helpers change to TALLY seeding per the new model):

```typescript
function seedTally(state: MockState, username: string, dimIndex: number, value: number) {
  state.setRegister(`dim:${username}:c${dimIndex}`, value);
}

describe('salient-derived vote balance', () => {
  it('quadratic vote draws from base + salient tallies (not res: register)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupProposal(node, state, 'p-sal', 'quadratic', 100000);
    // C_1 salient; alice settled building contributions → tally 10 → balance 3 + 10 = 13
    state.setRegister('proposals:p-sal:salient', (1 << 1));
    seedTally(state, 'alice', 1, 10);
    // alice has NO res: register at all — proves the vote reads tallies, not tokens
    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    // 3 quadratic votes at cumulative 1+4+9=14 > 13 → exactly 2 votes
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-sal', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-sal', choice: 0 }))).toBe(0);
    expect(state.getPNCounter('votes:p-sal:opt0_count')).toBe(2);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-sal', choice: 0 }))).toBe(-1);
  });

  it('base-only proposals (empty salient mask) give every member the base balance', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupProposal(node, state, 'p-base', 'quadratic', 100000);
    state.setRegister('proposals:p-base:salient', 0);
    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    // base 3: cumulative 1+4 = 5 > 3 → exactly 1 vote
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-base', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-base', choice: 0 }))).toBe(-1);
    // base is identical for a member with NO contributions
    state.setAdd(STATE_NAMES.members, 'nobody', 'nobody');
    expect(vote(state, makeOp('vote', 'nobody', { proposalId: 'p-base', choice: 0 }))).toBe(0);
  });

  it('create_proposal writes the salient mask from payload; invalid subsets rejected', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const nowMs = 0;
    const make = makeCreateProposalHandler(node, { getTimeMs: () => nowMs });
    expect(make(state, makeOp('create_proposal', 'alice', {
      proposalId: 'p1', title: 'T', description: 'D', proposalType: 'quadratic', options: ['Yes', 'No'], expiresAt: 1000, salientDims: [1, 18],
    }))).toBe(0);
    expect(state.getRegister('proposals:p1:salient')).toBe((1 << 1) | (1 << 18));
    expect(make(state, makeOp('create_proposal', 'alice', {
      proposalId: 'p2', title: 'T', description: 'D', proposalType: 'direct', options: ['Yes', 'No'], expiresAt: 1000,
    }))).toBe(0);
    expect(state.getRegister('proposals:p2:salient')).toBe(0); // absent → base-only
    expect(make(state, makeOp('create_proposal', 'alice', {
      proposalId: 'p3', title: 'T', description: 'D', proposalType: 'direct', options: ['Yes', 'No'], expiresAt: 1000, salientDims: [22],
    }))).toBe(-1);
  });
});
```

- [ ] **Step 3: Run** `npm test -- handlers.test.ts` → FAIL (mask register not written; votes still read res:).

- [ ] **Step 4: Implement**

In `makeCreateProposalHandler`, in the resource-init block (next to proposalType):

```typescript
    try { node.addRegister(TOKEN_NAMES.proposalSalient(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
```

validation: extend the payload guard — if `payload.salientDims !== undefined`, wrap `encodeSalientMask(payload.salientDims)` in try/catch: throw → return -1. Then in the write block:

```typescript
    const salientMask = payload.salientDims !== undefined ? encodeSalientMask(payload.salientDims) : 0;
    state.setRegister(TOKEN_NAMES.proposalSalient(payload.proposalId), salientMask, op.signerId);
```

Imports merge: `encodeSalientMask` from './round'.

In `makeVoteHandler` (quadratic branch), replace:

```typescript
      const balance = state.getRegister(RES_NAMES.balance(op.signerId)) || 0;
```

with:

```typescript
      const balance = derivedVoteBalance(
        state.getRegister(TOKEN_NAMES.proposalSalient(payload.proposalId)) || 0,
        (i) => state.getRegister(CALIBRATIONS.alpha(i)) || 1,
        (i) => state.getRegister(CONTRIB_NAMES.dimensionBalance(op.signerId, i)) || 0,
        state.getRegister(CALIBRATIONS.voteBase()) || 3,
        state.getRegister(CALIBRATIONS.voteCap()) || 50
      );
```

In `makeCastRunoffVoteHandler`, replace its balance read with:

```typescript
    const balance = state.getRegister(CALIBRATIONS.voteBase()) || 3;
```

(elections: base-only — runoffs have no salience; keep a one-line comment noting that). Remove the now-unused `RES_NAMES` import IF nothing else in handlers.ts uses it (grep — remove_member's zeroing still does).

- [ ] **Step 5: Run** full `npm test` — expect FAILURES in OLD balance-model tests (the quadratic tests seeded with `initUser(res:...)` from the accrual deletion). UPDATE those tests to the tally model: in `server/test/handlers.test.ts`, replace each quadratic test's `initUser(state, 'alice', 20)`-style funding with `seedTally(state, 'alice', 1, 17)` + a fresh proposal whose mask includes dim 1 (`state.setRegister('proposals:<id>:salient', 1 << 1)` — note `setupProposal` doesn't seed the mask; add `state.setRegister('proposals:pX:salient', 0)` per test where masks matter and keep base-only behavior for the masked-0 case). Boundary tests re-derive: base 3 → 1 vote; with tally 11 (base 3 + 11 = 14 ≤ cumulative 14 at 3 votes, 4th fails). Keep the gating semantics identical; rewrite assertions to the new funding. Delete tests that exist ONLY to pin the old per-balance accrual (none survive from the accrual deletion — verify by reading the list).
- [ ] **Step 6: Run** full `npm test` PASS (7 suites, all green).
- [ ] **Step 7: Commit**

```bash
git add shared/src/types.ts shared/src/handlers.ts server/test/handlers.test.ts
git commit -m "feat!: quadratic votes draw from salient-derived balances (base + capped tally sum)"
```

---

### Task 6: Server wiring — round registers, policies, handlers, getters

**Files:**
- Modify: `server/src/crabs.ts`
- Test: `server/test/crabs.test.ts`

- [ ] **Step 1: Real-wasm test first (red)** — append to `server/test/crabs.test.ts` (reuse its signed-op helper; drive the FULL spine across two contributions):

```typescript
it('full round spine through the real wasm node', async () => {
  const dao = new DaoNode();
  await dao.init();
  // members: alice, bob, closer — all via registerMember + real key pairs
  // (follow the file's existing helper pattern exactly)
  // 1. custodian sets calibration: (use an ADMIN-signed op or grant one member
  //    custodian first — follow the file's admin-op helper for set_calibration_version)
  // 2. alice submits r1-x (dims {1:1}, evidenceRef'd) → pending
  // 3. bob verifies accepted → step advances; alice settles
  // 4. closer: audit_round fair → reckon → complete_round with entries [r1-x]
  // asserts:
  expect(dao.getCurrentRound()).toBe(2);
  expect(dao.getRoundStage(1)).toBe(3);
  expect(dao.getRctBalance('alice')).toBe(12); // alpha default 1 × 12?? NO — alpha(1) unset → 1; tally for c1 is 1 → RCT 1
});
```

STOP — the expected values must be derived from the actual alpha defaults (unset alpha → 1) and the contribution's tally (match 1 → tally dim 1 = 1 → RCT = 1×1 = 1). Correct assert: `expect(dao.getRctBalance('alice')).toBe(1);` — write the test with these values and a comment explaining why.

Also add the calibration setup assertion: after `set_calibration_version` (admin-signed via `createAdminOperation`), `dao.getCalibrationVersion() ?? 0` reads 1.

- [ ] **Step 2: Run** `npm test -- crabs.test.ts` → FAIL (getters/handlers unavailable).

- [ ] **Step 3: Implement** — in `server/src/crabs.ts`:

Init block:

```typescript
    this.node.addRegister(ROUND_NAMES.current(), 1);
    this.node.addRegister(ROUND_NAMES.stage(1), 0);
    this.node.addORSet(ROUND_NAMES.explanations(1));
    this.node.addRegister(CALIBRATIONS.calibrationVersion(), 1); // pilot bootstrap: 'v1' pre-set; custodians revise via set_calibration_version
    this.node.addRegister(CALIBRATIONS.alphaVersion(), 0);
    this.node.addRegister(CALIBRATIONS.voteBase(), 0);
    this.node.addRegister(CALIBRATIONS.voteCap(), 0);
    this.node.addORSet(CALIBRATIONS.explanations());
```

(Pilot bootstrap pre-sets the Justice calibration to 'v1' — the demo needs a workable Justice gate on day one; custodians revise via the op. Document with the comment shown.)

Policies (all five):

```typescript
    this.node.setPolicy('audit_round', POLICIES.audit_round);
    this.node.setPolicy('reckon_round', POLICIES.reckon_round);
    this.node.setPolicy('complete_round', POLICIES.complete_round);
    this.node.setPolicy('set_rct_alpha', POLICIES.set_rct_alpha);
    this.node.setPolicy('set_calibration_version', POLICIES.set_calibration_version);
```

Handlers (all five factories with `getTimeMs` where supported — `audit_round`, `reckon_round`, `complete_round` take config; the two calibration handlers take only `node`):

```typescript
    this.node.registerHandlerJs('audit_round', makeAuditRoundHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('reckon_round', makeReckonRoundHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('complete_round', makeCompleteRoundHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('set_rct_alpha', makeSetRctAlphaHandler(this.node));
    this.node.registerHandlerJs('set_calibration_version', makeSetCalibrationVersionHandler(this.node));
```

Getters:

```typescript
  getCurrentRound(): number {
    return this.node.getRegister(ROUND_NAMES.current()) || 1;
  }

  getRoundStage(round: number): number {
    return this.node.getRegister(ROUND_NAMES.stage(round)) || 0;
  }

  getRctBalance(username: string): number {
    return this.node.getRegister(RCT_NAMES.balance(username)) || 0;
  }

  getCalibrationVersion(): number {
    return this.node.getRegister(CALIBRATIONS.calibrationVersion()) || 1;
  }
```

- [ ] **Step 4: Run** full `npm test` PASS.
- [ ] **Step 5: Commit**

```bash
git add server/src/crabs.ts server/test/crabs.test.ts
git commit -m "feat(server): round spine registers, calibration ops, full-spine wasm test"
```

---

### Task 7: Client wiring — mirrors, sign methods, getters

**Files:**
- Modify: `client/src/dao.ts`
- Modify: `client/src/server-client.ts` (none needed — round ops ride `submit_op`)
- Verify: `npx tsc -p client/tsconfig.json --noEmit` + `npm run build:client`

- [ ] **Step 1: BrowserDao parity** (same wiring as Task 6 mirrored into dao.ts; imports from '@shared/…' style):

```typescript
    this.node.addRegister(ROUND_NAMES.current(), 1);
    this.node.addRegister(ROUND_NAMES.stage(1), 0);
    this.node.addORSet(ROUND_NAMES.explanations(1));
    this.node.addRegister(CALIBRATIONS.calibrationVersion(), 1);
    this.node.addRegister(CALIBRATIONS.alphaVersion(), 0);
    this.node.addRegister(CALIBRATIONS.voteBase(), 0);
    this.node.addRegister(CALIBRATIONS.voteCap(), 0);
    this.node.addORSet(CALIBRATIONS.explanations());

    this.node.setPolicy('audit_round', POLICIES.audit_round);
    this.node.setPolicy('reckon_round', POLICIES.reckon_round);
    this.node.setPolicy('complete_round', POLICIES.complete_round);
    this.node.setPolicy('set_rct_alpha', POLICIES.set_rct_alpha);
    this.node.setPolicy('set_calibration_version', POLICIES.set_calibration_version);

    this.node.registerHandlerJs('audit_round', makeAuditRoundHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('reckon_round', makeReckonRoundHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('complete_round', makeCompleteRoundHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('set_rct_alpha', makeSetRctAlphaHandler(this.node));
    this.node.registerHandlerJs('set_calibration_version', makeSetCalibrationVersionHandler(this.node));
```

- [ ] **Step 2: Sign methods** next to settleContribution:

```typescript
  async auditRound(userId: string, payload: AuditRoundPayload): Promise<Uint8Array> {
    return this.signAndSerialize('audit_round', userId, JSON.stringify(payload));
  }

  async reckonRound(userId: string, payload: ReckonRoundPayload): Promise<Uint8Array> {
    return this.signAndSerialize('reckon_round', userId, JSON.stringify(payload));
  }

  async completeRound(userId: string, payload: CompleteRoundPayload): Promise<Uint8Array> {
    return this.signAndSerialize('complete_round', userId, JSON.stringify(payload));
  }

  async setRctAlpha(userId: string, payload: SetRctAlphaPayload): Promise<Uint8Array> {
    return this.signAndSerialize('set_rct_alpha', userId, JSON.stringify(payload));
  }

  async setCalibrationVersion(userId: string, payload: SetCalibrationVersionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('set_calibration_version', userId, JSON.stringify(payload));
  }
```

- [ ] **Step 3: Getters** (client-side mirror of Task 6 getters, plus the UI helpers):

```typescript
  getCurrentRound(): number {
    return this.node.getRegister(ROUND_NAMES.current()) || 1;
  }

  getRoundStage(round: number): number {
    return this.node.getRegister(ROUND_NAMES.stage(round)) || 0;
  }

  getRctBalance(username: string): number {
    return this.node.getRegister(RCT_NAMES.balance(username)) || 0;
  }

  getVoteBalance(proposalId: string, username: string): number {
    // UI mirrors the handler's derived-balance math so cards and state agree.
    const mask = this.node.getRegister(`proposals:${proposalId}:salient`) || 0;
    return derivedVoteBalance(
      mask,
      (i) => this.node.getRegister(`config:alpha:${i}`) || 1,
      (i) => this.node.getRegister(`dim:${username}:c${i}`) || 0,
      this.node.getRegister('config:vote_base') || 3,
      this.node.getRegister('config:weight_cap') || 50
    );
  }
```

- [ ] **Step 4: Round-ops mirror** (payload-parse into a Map like contributions; records are attributed to the round whose stage was just advanced — `complete_round` bumps `round:current` before this mirror runs, so subtract 1 for those):

```typescript
  private async mirrorRoundState(op: any): Promise<void> {
    if (op.type !== 'audit_round' && op.type !== 'reckon_round' && op.type !== 'complete_round') return;
    let payload: any = null;
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      payload = JSON.parse(json.replace(/\0$/, ''));
    } catch { return; }
    if (op.type === 'complete_round' && Array.isArray(payload.entries)) {
      // Mirror entries for the UI's next-round collection.
      for (const entry of payload.entries) { /* no-op — entries already settled */ }
    }
    const roundNo = this.node.getRegister(ROUND_NAMES.current()) || 1;
    const offset = op.type === 'complete_round' ? 1 : 0;
    const target = roundNo - offset;
    const record = { stepId: op.type === 'complete_round' ? 'complete' : op.type === 'audit_round' ? 'audit' : 'reckon', by: op.signerId, ...payload };
    const list = this.roundRecords.get(target) ?? [];
    list.push(record);
    this.roundRecords.set(target, list);
  }

  getRoundRecords(round: number): Array<Record<string, unknown>> {
    return this.roundRecords.get(round) ?? [];
  }
```

Hook `await this.mirrorRoundState(op);` into `executeRemote` alongside mirrorContributionState, and expose:

```typescript
  getRoundRecords(round: number): Array<Record<string, unknown>> {
    return this.roundRecords.get(round) ?? [];
  }
```

- [ ] **Step 5: Compile check + suite gate**

Run: `npx tsc -p client/tsconfig.json --noEmit` (no new errors beyond the two pre-existing wrapper files) and `npm run build:client` and `npm test` (all green).

- [ ] **Step 6: Commit**

```bash
git add client/src/dao.ts
git commit -m "feat(client): round spine mirrors, sign methods, and UI vote-balance helper"
```

---

### Task 8: UI — round panel, salient picker, RCT badges

**Files:**
- Modify: `client/index.html` (round panel markup; salient picker in the proposal form)
- Modify: `client/src/ui.ts` (round rendering, audit/reckon/complete/custodian flows; derived-balance display)
- Verify: `npm run build:client` + manual two-browser verification

- [ ] **Step 1: Markup (index.html)** — add a round panel section (before or after the proposals section, following the page's existing section conventions):

```html
<section id="round-panel">
  <h3>Round</h3>
  <div id="round-stepper"></div>
  <div id="round-explanations" class="muted"></div>
  <button id="audit-round-btn" class="button button--secondary hidden">Audit round…</button>
  <button id="reckon-round-btn" class="button button--secondary hidden">Reckon round…</button>
  <button id="complete-round-btn" class="button button--primary hidden">Complete round &amp; publish</button>
  <div id="round-alpha-form" class="hidden">
    <input id="alpha-c1" placeholder="alpha C_1 (e.g. 2)" />
    <input id="alpha-c2" placeholder="alpha C_2 (e.g. 0.5)" />
    <input id="alpha-version" placeholder="weights version label" />
    <button id="set-alpha-btn" class="button button--secondary">Set weights</button>
    <button id="set-calibration-btn" class="button button--secondary">Set calibration v1</button>
  </div>
</section>
```

Add the salient picker to the existing proposal form (ids consistent with ui.ts):

```html
<fieldset id="proposal-salient">
  <legend>Salient dimensions for quadratic votes (empty = base membership only)</legend>
  <label><input type="checkbox" class="salient-dim" value="1" /> C_1 Building</label>
  <label><input type="checkbox" class="salient-dim" value="2" /> C_2 Recording</label>
  <label><input type="checkbox" class="salient-dim" value="18" /> C_18 Verifying</label>
</fieldset>
```

(Phase-2 UI exposes the three implemented dims as the demo picker; the mask supports all 22.)

- [ ] **Step 2: ui.ts flows** — bind + handlers (same try/submit/safeExecuteRemote/finally pattern as onVerifyContribution; full bodies, no ellipses):

```typescript
  private async onAuditRound() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    const fair = confirm('Close the round as FAIR? OK = fair, Cancel = UNFAIR (records the round debt and skips aggregation).');
    const note = prompt('Audit note (recorded permanently):') ?? '';
    if (!note.trim()) {
      this.setStatus('An audit note is required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.auditRound(this.wallet.username, {
        fair,
        note,
        calibrationVersion: 'v1',
      });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(fair ? 'Round audited as fair.' : 'Round closed with a debt record; next round begins.', fair ? 'success' : 'error');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Audit error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onReckonRound() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    const note = prompt('Reckoning note (recorded permanently):') ?? '';
    if (!note.trim()) {
      this.setStatus('A reckoning note is required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.reckonRound(this.wallet.username, { note });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Round reckoned — ready to complete.', 'success');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Reckon error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onCompleteRound() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    this.setSubmitting(true);
    try {
      const currentRound = this.dao.getCurrentRound();
      const entries = this.dao.getContributions()
        .filter((entry) => this.dao!.getContributionStatus(entry.record.contributionId) === 'accepted'
          && this.dao!.getContributionRound(entry.record.contributionId) === currentRound)
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter, dims: entry.record.dims }));
      if (entries.length === 0) {
        this.setStatus('Nothing settled to aggregate in this round.', 'error');
        return;
      }
      const bytes = await this.dao.completeRound(this.wallet.username, { entries });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Round published — ${entries.length} contribution(s) aggregated.`, 'success');
      this.renderRound();
      this.renderTokenBalance();
    } catch (err) {
      this.setStatus(`Complete error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }
```

(This requires `getContributionRound` on BrowserDao: `return this.node.getRegister(CONTRIB_NAMES.contributionRound(id)) || 0;` — add it in Task 7 Step 3's getter list if forgotten there; this task relies on it — if missing, add it here and note it in the report.)

Custodian calibration (mirror onSetTokenConfig's old form pattern):

```typescript
  private async onSetAlpha() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    const raw: Record<string, number> = {};
    const c1 = parseFloat(this.inputValue('alpha-c1'));
    const c2 = parseFloat(this.inputValue('alpha-c2'));
    if (Number.isFinite(c1) && c1 > 0) raw['1'] = c1;
    if (Number.isFinite(c2) && c2 > 0) raw['2'] = c2;
    const version = this.inputValue('alpha-version');
    if (Object.keys(raw).length === 0 || !version.trim()) {
      this.setStatus('At least one weight and a version label are required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.setRctAlpha(this.wallet.username, { weights: raw, version: version.trim() });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('RCT weights updated.', 'success');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Weights error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onSetCalibration() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.setCalibrationVersion(this.wallet.username, { version: 'v1' });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Calibration version set to v1.', 'success');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Calibration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }
```

- [ ] **Step 3: Rendering** — `renderRound()` (add to the demo-clock refresh list after `renderContributions()`):

```typescript
  private renderRound() {
    if (!this.dao || !this.wallet) return;
    const stepper = document.getElementById('round-stepper');
    const current = this.dao.getCurrentRound();
    const stage = this.dao.getRoundStage(current);
    if (!stepper) return;
    const stageNames = ['Open', 'Audited', 'Reckoned', 'Published'];
    stepper.innerHTML = '';
    const roundLabel = document.createElement('span');
    roundLabel.className = 'round-label';
    roundLabel.textContent = `Round ${current} — stage: ${stageNames[stage] ?? 'unknown'}`;
    stepper.appendChild(roundLabel);

    const isCustodian = this.dao.custodians.includes(this.wallet.username);
    const auditBtn = document.getElementById('audit-round-btn');
    const reckonBtn = document.getElementById('reckon-round-btn');
    const completeBtn = document.getElementById('complete-round-btn');
    const alphaForm = document.getElementById('round-alpha-form');
    if (auditBtn) auditBtn.classList.toggle('hidden', stage !== 0);
    if (reckonBtn) reckonBtn.classList.toggle('hidden', stage !== 1);
    if (completeBtn) completeBtn.classList.toggle('hidden', stage !== 2);
    if (alphaForm) alphaForm.classList.toggle('hidden', !isCustodian);

    const explanations = document.getElementById('round-explanations');
    if (explanations) {
      const records = this.dao.getRoundRecords(current);
      explanations.textContent = records.length === 0 ? '' : records.map((r) => `${String(r.stepId)}: ${String(r.note ?? '')}`).join(' | ');
    }

    // RCT badges in the members list:
    for (const username of [this.wallet.username, ...this.memberUsernames]) {
      const el = document.querySelector(`[data-member-rct="${username}"]`);
      if (!el) continue;
      el.textContent = `${this.dao.getRctBalance(username)} RCT`;
    }
  }
```

(RCT badge anchoring `[data-member-rct]` requires one line in the existing member rendering to add the span with that attribute — include it.)

- [ ] **Step 4: Proposal salience wiring** — in the proposal-creation handler, read the checked `.salient-dim` checkboxes into `salientDims` (empty → omit the field). In the quadratic proposal card rendering, replace the token-usage/balance line's balance source: `this.dao.getVoteBalance(proposal.proposalId, this.wallet.username)` (label: "Your balance for this question"). Keep `getProposalTokenUsage` (cost spent here) as-is.

- [ ] **Step 5: Build + manual flow**

Run: `npm run build:client`. Then `npm run dev` and, in two browsers (alice/bob), verify:
1. alice submits a C_1 contribution; bob verifies; alice settles → badge shows both balances.
2. Round panel: Audit (fair) → Reckon → Complete & publish → round advances; alice's RCT badge = building bounty × alpha default (12 × 1 = 12).
3. Create a quadratic proposal with C_1 salient and vote as alice twice with the derived balance (12 → 2 votes at cumulative 1+4=5 ≤ 12, third at 14 > 12 blocked) — note votes no longer consume $RES.
4. Create a base-only quadratic proposal (no salience) — every member gets base (3 → exactly 1 vote).
5. As bob (non-custodian): the alpha form is hidden.

- [ ] **Step 6: Commit**

```bash
git add client/index.html client/src/ui.ts
git commit -m "feat(ui): round panel, salient picker, and RCT badges"
```

---

### Task 9: e2e, hydration, docs

**Files:**
- Modify: `test-voting-browser.js` (round-spine section: audit → reckon → complete → next-round vote on salient balance)
- Modify: `server/test/hydration.test.ts` (round registers + published RCT survive replay)
- Modify: `docs/contribution-economy/README.md` (binding section update)

- [ ] **Step 1: Hydration test (red first)** — append to `server/test/hydration.test.ts`: drive a full spine (submit/verify/settle a contribution via signed ops; custodian set_calibration_version via the admin-op helper; audit/reckon/complete) with all ops persisted; fresh DaoNode + hydrateDao; assert:

```typescript
      expect(second.getCurrentRound()).toBe(2);
      expect(second.getRoundStage(1)).toBe(3);
      expect(second.getRctBalance('alice')).toBe(1); // alpha default 1; tally dim 1 = 1
      expect(second.getContributionStatus('r-eco1')).toBe('accepted');
```

(deriving the RCT value from the test's actual contribution dims/match — comment the arithmetic next to the assert).

- [ ] **Step 2: e2e extension** — in `test-voting-browser.js`, after the existing wizard cycle: alice (or whichever member the script's custodian is) runs set_calibration (`onSetCalibration` path or direct form), audits fair, reckons, completes (collecting the accepted entry list), then starts a NEW round quadratic proposal with C_1 salient and asserts the derived-balance gating (alice's bounty → 2 votes at base+12; blocked after). Follow the script's existing dialog-arming + retry conventions; requires a fresh server DB (script header documents this — keep).

- [ ] **Step 3: Run both** — `npm test` (all green, expect 8+ suites) and the e2e script per its header instructions (report honestly; it needs the dev server + fresh DB). e2e expected output includes the spine assertions and "Smoke test passed" with the round-extension run.

- [ ] **Step 4: Docs** — in `docs/contribution-economy/README.md`, extend the "Binding to the reference implementation" section with:

```markdown
- Phase 2 (2026-10-06): round spine (`audit_round` C_10 fair close with debt
  path, `reckon_round` C_20 behind the Justice calibration gate,
  `complete_round` C_21 payload-driven aggregation), published per-member
  `$RCT = Σ alpha_i × match` (cumulative, alpha forward-looking — pilot
  calibration caveat), custodian `set_rct_alpha`/`set_calibration_version`
  ops, and salient-dimension quadratic voting: vote balance = base + capped
  Σ alpha × tally over the question's declared salient dims (mask register;
  elections stay base-only). $RES no longer gates votes. $RCT is publish-only;
  the RCT-as-vote-token question stays open (see the phase-2 spec).
```

- [ ] **Step 5: Commit**

```bash
git add test-voting-browser.js server/test/hydration.test.ts docs/contribution-economy/README.md
git commit -m "test/docs: round spine hydration + e2e coverage and phase-2 binding docs"
```

---

## Self-review

- **Spec coverage:** spine stages + debt path (Tasks 3-4), Justice gate (Task 3 reckon + register init in Task 6), payload-driven aggregation with round-stamp validation + cumulative RCT + forward-looking alpha (Task 4), custodian calibration/alpha ops (Task 2), salient mask on proposals + derived balance + base/cap (Tasks 1, 5), runoff base-only (Task 5), $RES un-gated (Task 5 — res: reads removed from vote paths; remove_member zeroing untouched), publish-only RCT (Tasks 4, 6 getters; nothing reads rct: for gating), UI (Task 8), testing ladder + docs (Task 9).
- **Placeholder scan:** the Task 7 mirror sketch includes a deliberately-discarded draft — final implementation uses only the simplified `mirrorRoundState` (labeled as such); the plan instructs deleting the draft version. No TBDs otherwise.
- **Type consistency:** `RoundEntry`/`isValidRoundEntry`/`AGGREGATE_ENTRY_LIMIT`/`roundRctTotals`/`derivedVoteBalance`/`encodeSalientMask`/stage constants defined in Task 1, consumed in Tasks 4-5. `ROUND_NAMES`/`CALIBRATIONS`/`RCT_NAMES` defined in Task 1, consumed in Tasks 3-7. `CONTRIB_NAMES.contributionRound` defined in Task 1, written in Task 4, read in Task 4's validation and Task 8's UI collection. `TOKEN_NAMES.proposalSalient` written in Task 5, read in Tasks 5 + 7 (getVoteBalance). Payloads from Task 2/3/4 consumed by Task 7 sign methods + Task 8 flows.
- **Ordering note:** Task 5 changes the funding model of ALL existing quadratic tests — that suite edit is the biggest risk; the plan pins exact funding replacements (seedTally + mask registration) and expects the boundary values (base 3 → 1 vote; tally 11 → 3 votes at cumulative 14) to be re-derived in-task.