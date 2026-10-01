# Replace Timed Token Allocation with Contribution Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the timed (lazy-accrual) token allocation and pay the transferable `$RES` token only when contribution-economy outcome rules fire — contributions are submitted, verified by another member (C_18 Moon), and accepted contributions pay class-specific bounties (C_1 building, C_2 recording) into per-member 22-dimension tallies, with explanation records on every decision.

**Architecture:** Everything follows the repo's existing CRABS replication model: new op types (`submit_contribution`, `verify_contribution`) get JS handlers in `shared/src/handlers.ts`, registered identically on the server `DaoNode` and the `BrowserDao` browser mirror, so all replicas converge by executing the same signed-op log. Tokens keep living in CRABS registers keyed by username; voting keeps its quadratic cost mechanics but reads the `$RES` balance register, which no longer accrues and is only credited by verification outcomes. Payment rules live in a new data module (`shared/src/contribution.ts`) holding the 22-dimension registry so later phases add dimensions without touching handlers.

**Tech Stack:** TypeScript, crabs-wasm (CRABS), WaveDB (op-log persistence), Vite/esbuild client, Jest (server tests), Playwright e2e script.

**Phasing (per 2026-09-30 decision):** This plan implements the core lifecycle + 3 dimensions with real payment rules (C_1 Magician/building, C_2 Priestess/recording, C_18 Moon/verifying). The other 19 dimensions are classification targets (their scores are recorded in tallies) but pay nothing yet. Round spine (C_10/C_20/C_21), $RCT aggregation, tiered verification (Tier 1/3), harm checks, retrieval bonuses, and weight calibration are **separate future issues** — this plan deliberately does not include them.

**Known PoC limitations carried forward (documented, not fixed here):**
- `verify_contribution` trusts the payload's `dims` and `submitter` (handler state cannot enumerate ORSet elements). Server and all replicas recompute payments deterministically from the same payload, so state still converges, but a dishonest verifier could overstate `dims` (this is "reviewer capture" territory — future issue).
- New members start with `$RES` balance 0 and earn their first tokens by having a contribution verified or by verifying someone else's contribution (C_18 pays the verifier per completed check regardless of direction). There is no free seed grant anymore.
- CRABS registers are numbers only; a dimension tally register that has never been updated reads as `0`. True null-vs-verified-zero preservation is deferred (future issue on the 22-vector source record).

---

### Task 1: Contribution registry module and shared types

**Files:**
- Create: `shared/src/contribution.ts`
- Modify: `shared/src/policies.ts` (add `RES_CONFIG`, `RES_NAMES`, `CONTRIB_NAMES`, `TIMING`; add policies; add `contributions` state name)
- Modify: `shared/src/types.ts` (add payloads; remove `SetTokenConfigPayload`, `TokenConfig`)
- Create: `server/test/contribution.test.ts`
- Modify: `shared/src/handlers.ts`, `shared/src/policies.ts` imports are done in later tasks — in this task only *add*, do not remove old names yet (older tasks keep compiling).

- [ ] **Step 1: Write the failing test**

Create `server/test/contribution.test.ts`:

```typescript
import {
  DIMENSIONS, DIMENSION_COUNT, isValidDims, paymentFor, CALIBRATION_VERSION,
} from '../../shared/src/contribution';
import { RES_CONFIG } from '../../shared/src/policies';

describe('contribution registry', () => {
  it('defines exactly 22 dimensions indexed C_0..C_21', () => {
    expect(DIMENSIONS.length).toBe(22);
    expect(DIMENSION_COUNT).toBe(22);
    DIMENSIONS.forEach((d, i) => expect(d.index).toBe(i));
    expect(DIMENSIONS[1].code).toBe('C_1');
    expect(DIMENSIONS[1].name).toBe('Magician');
    expect(DIMENSIONS[18].name).toBe('Moon');
  });

  it('marks exactly C_1, C_2 and C_18 as implemented for payment', () => {
    const implemented = DIMENSIONS.filter((d) => d.implemented).map((d) => d.index);
    expect(implemented.sort()).toEqual([1, 2, 18]);
  });

  describe('isValidDims', () => {
    it('accepts a sparse map of valid indices with weights in (0, 1]', () => {
      expect(isValidDims({ '1': 1, '2': 0.5 })).toBe(true);
      expect(isValidDims({ '18': 0.25 })).toBe(true);
    });
    it('rejects bad indices, weights, and shapes', () => {
      expect(isValidDims({})).toBe(false);
      expect(isValidDims({ '-1': 1 })).toBe(false);
      expect(isValidDims({ '22': 1 })).toBe(false);
      expect(isValidDims({ '1.5': 1 })).toBe(false);
      expect(isValidDims({ '1': 0 })).toBe(false);
      expect(isValidDims({ '1': 2 })).toBe(false);
      expect(isValidDims([1, 2])).toBe(false);
      expect(isValidDims(null)).toBe(false);
    });
  });

  it('pays building and recording bounties scaled by match weight', () => {
    expect(paymentFor(1, 1)).toBe(RES_CONFIG.buildingBounty);
    expect(paymentFor(2, 0.5)).toBe(RES_CONFIG.recordingBaseCredit * 0.5);
  });
  it('pays nothing for dimensions without implemented rules', () => {
    expect(paymentFor(0, 1)).toBe(0);
    expect(paymentFor(18, 1)).toBe(0); // C_18 pays the verifier, not the submitter
    expect(paymentFor(7, 1)).toBe(0);
  });
  it('has a stable calibration version string', () => {
    expect(CALIBRATION_VERSION).toBe('v1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contribution.test.ts` (from repo root)
Expected: FAIL — module `../../shared/src/contribution` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `shared/src/contribution.ts`:

```typescript
// Contribution economy registry — mirrors docs/contribution-economy/README.md
// and docs/superpowers/specs/2026-09-16-contribution-economy-workflows-design.md.
// Phase 1 implements payment rules only for C_1 (building), C_2 (recording)
// and C_18 (verifying); other dimensions classify actions into the 22-vector
// but pay nothing.

export interface DimensionDef {
  index: number;
  code: string;
  name: string;
  cls: string; // ontology class from docs/contribution-economy/diagrams.json
  implemented: boolean; // has a phase-1 RES payment rule
}

export const DIMENSION_COUNT = 22 as const;

export const DIMENSIONS: DimensionDef[] = [
  { index: 0, code: 'C_0', name: 'Fool', cls: 'Crossing', implemented: false },
  { index: 1, code: 'C_1', name: 'Magician', cls: 'Building', implemented: true },
  { index: 2, code: 'C_2', name: 'Priestess', cls: 'Recording', implemented: true },
  { index: 3, code: 'C_3', name: 'Empress', cls: 'Nurturing', implemented: false },
  { index: 4, code: 'C_4', name: 'Emperor', cls: 'Structuring', implemented: false },
  { index: 5, code: 'C_5', name: 'Hierophant', cls: 'Teaching', implemented: false },
  { index: 6, code: 'C_6', name: 'Lovers', cls: 'Joining', implemented: false },
  { index: 7, code: 'C_7', name: 'Chariot', cls: 'Driving', implemented: false },
  { index: 8, code: 'C_8', name: 'Strength', cls: 'Resolving', implemented: false },
  { index: 9, code: 'C_9', name: 'Hermit', cls: 'Discovering', implemented: false },
  { index: 10, code: 'C_10', name: 'Wheel', cls: 'Cycling', implemented: false },
  { index: 11, code: 'C_11', name: 'Justice', cls: 'Weighing', implemented: false },
  { index: 12, code: 'C_12', name: 'Hanged Man', cls: 'Re-seeing', implemented: false },
  { index: 13, code: 'C_13', name: 'Death', cls: 'Ending', implemented: false },
  { index: 14, code: 'C_14', name: 'Temperance', cls: 'Balancing', implemented: false },
  { index: 15, code: 'C_15', name: 'Devil', cls: 'Exposing', implemented: false },
  { index: 16, code: 'C_16', name: 'Tower', cls: 'Responding', implemented: false },
  { index: 17, code: 'C_17', name: 'Star', cls: 'Meaning', implemented: false },
  { index: 18, code: 'C_18', name: 'Moon', cls: 'Verifying', implemented: true },
  { index: 19, code: 'C_19', name: 'Sun', cls: 'Celebrating', implemented: false },
  { index: 20, code: 'C_20', name: 'Judgement', cls: 'Reckoning', implemented: false },
  { index: 21, code: 'C_21', name: 'World', cls: 'Integrating', implemented: false },
];

export const CALIBRATION_VERSION = 'v1' as const;

// Phase-1 simplification of `Delta C_i(a) = Match_i × Outcome × Verification ×
// Calibration_i` with Calibration_i = 1 and Outcome/Verification ∈ {0,1}:
// an accepted contribution's dimension tally grows by its match weight.
export function dimensionDeltaFor(dimIndex: number, match: number): number {
  return match;
}

export function isValidDims(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== 'object' || Array.isArray(dims)) return false;
  const entries = Object.entries(dims as Record<string, unknown>);
  if (entries.length === 0 || entries.length > DIMENSION_COUNT) return false;
  return entries.every(([key, value]) => {
    const index = Number(key);
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < DIMENSION_COUNT &&
      String(index) === String(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 1
    );
  });
}

export function paymentFor(dimIndex: number, match: number): number {
  if (dimIndex === 1) return RES_CONFIG.buildingBounty * match;
  if (dimIndex === 2) return RES_CONFIG.recordingBaseCredit * match;
  return 0; // C_18 pays the verifier per completed check, not the submitter
}
```

Modify `shared/src/policies.ts` — add after `VOTE_THRESHOLD` (line 1), keeping everything else for now:

```typescript
// $RES — the transferable token paid only when a class-specific outcome rule
// fires. No time-based accrual: balances only move through verified
// contributions.
export const RES_CONFIG = {
  verificationCheckCredit: 2, // C_18 Moon: per completed check, either direction
  buildingBounty: 12,         // C_1 Magician: delivery bounty on acceptance
  recordingBaseCredit: 3,     // C_2 Priestess: base credit on accepted record
} as const;
```

Add to `STATE_NAMES` (policies.ts:23-27):

```typescript
export const STATE_NAMES = {
  members: 'members',
  proposals: 'proposals',
  executedProposals: 'executed',
  contributions: 'contributions',
} as const;
```

Add to `POLICIES` (policies.ts:10-21), before the closing `} as const;`:

```typescript
  submit_contribution: 'role:member',
  verify_contribution: 'role:member',
```

Add `RES_NAMES` and `CONTRIB_NAMES` after the `TOKEN_NAMES` block (policies.ts:43):

```typescript
export const RES_NAMES = {
  balance: (username: string) => `res:${username}`,
} as const;

export const CONTRIB_NAMES = {
  // Contribution status register: 0 = pending, 1 = accepted, 2 = rejected.
  status: (contributionId: string) => `contrib:${contributionId}:st`,
  // ORSet holding one JSON explanation record per decision (submit, verify).
  explanations: (contributionId: string) => `contrib:${contributionId}:e`,
  // Per-member 22-dimension tally register (absence-of-delta = never set).
  dimensionBalance: (username: string, dimIndex: number) => `dim:${username}:c${dimIndex}`,
} as const;
```

Modify `shared/src/types.ts` — add after `SyncRolesPayload` (line 81):

```typescript
export interface ContributionPayload {
  contributionId: string;
  dims: Record<string, number>; // sparse P(a): dimension index -> match weight (0,1]
  summary: string;
  evidence: string; // free-form reference to the evidence (record id, URL, commit, …)
}

export interface VerifyContributionPayload {
  contributionId: string;
  submitter: string; // who submitted the contribution (PoC: payload-attested)
  dims: Record<string, number>; // must be presented for deterministic payment recomputation
  pass: boolean;
  reason: string; // written reason for the explanation record
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS (9 tests across 5 suites cases).

- [ ] **Step 5: Run the full existing suite (nothing may regress yet)**

Run: `npm test`
Expected: PASS — no existing behavior changed in this task.

- [ ] **Step 6: Commit**

```bash
git add shared/src/contribution.ts shared/src/policies.ts shared/src/types.ts server/test/contribution.test.ts
git commit -m "feat: add contribution economy registry, RES config, and contribution payloads"
```

---

### Task 2: submit_contribution handler

**Files:**
- Modify: `shared/src/handlers.ts` (add `makeSubmitContributionHandler`)
- Test: `server/test/contribution.test.ts`

`submit_contribution` corresponds to the master lifecycle: "Record what happened and prove it is real". The record is stored as: membership in `STATE_NAMES.contributions` (element = contributionId, tag = submitter), a status register, and a submit explanation record in the per-contribution explanation ORSet.

- [ ] **Step 1: Write the failing test**

Append to `server/test/contribution.test.ts` (add these imports/helpers at the top of the file; the `MockNode`/`MockState`/`makeOp` helpers live in `server/test/handlers.test.ts` — **copy them into this file** rather than exporting from the test, to avoid coupling test files):

```typescript
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { makeSubmitContributionHandler, makeVerifyContributionHandler } from '../../shared/src/handlers';
import { CONTRIB_NAMES, STATE_NAMES } from '../../shared/src/policies';
import { ContributionPayload, VerifyContributionPayload } from '../../shared/src/types';

// --- MockNode / MockState / makeOp: same implementations as
// --- server/test/handlers.test.ts (copy verbatim from that file) ---

function setupMembers(state: MockState, ...usernames: string[]) {
  for (const u of usernames) state.setAdd(STATE_NAMES.members, u, u);
}

function submitOp(payload: Partial<ContributionPayload>, signer = 'alice'): ContributionPayload {
  return {
    contributionId: 'c-1',
    dims: { '2': 1 },
    summary: 'Wrote an architecture record',
    evidence: 'docs/arch.md',
    ...payload,
  } as ContributionPayload;
}
```

Test cases:

```typescript
describe('submit_contribution handler', () => {
  it('records the contribution as pending with an explanation record', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({} )))).toBe(0);
    expect(state.setContains(STATE_NAMES.contributions, 'c-1')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(0);
  });

  it('rejects an unknown submitter (non-member)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSubmitContributionHandler(node);
    expect(handler(state, makeOp('submit_contribution', 'mallory', submitOp({})))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-1')).toBe(false);
  });

  it('rejects a duplicate contributionId', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    handler(state, makeOp('submit_contribution', 'alice', submitOp({})));
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ summary: 'again' })))).toBe(-1);
  });

  it('rejects invalid dims payloads', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ dims: {} })))).toBe(-1);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ dims: { '22': 1 } })))).toBe(-1);
  });

  it('rejects missing summary or evidence (pay on outcome, never on activity)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ summary: '' })))).toBe(-1);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ evidence: '' })))).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contribution.test.ts`
Expected: FAIL — `makeSubmitContributionHandler` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `shared/src/handlers.ts` (imports: `ContributionPayload` from `./types`, `CONTRIB_NAMES`, `RES_NAMES` from `./policies`, `isValidDims` from `./contribution` — it is a sibling module of `./handlers`):

```typescript
export function makeSubmitContributionHandler(
  node: { addORSet(name: string): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.summary) ||
      !isNonEmptyString(payload.evidence) ||
      !isValidDims(payload.dims) ||
      !state.setContains(STATE_NAMES.members, op.signerId) ||
      state.setContains(STATE_NAMES.contributions, payload.contributionId)
    ) {
      return -1;
    }

    try { node.addORSet(CONTRIB_NAMES.explanations(payload.contributionId)); } catch (err) { /* ignore duplicate */ }
    try { state.setRegister(CONTRIB_NAMES.status(payload.contributionId), 0, op.signerId); } catch (err) { /* always writable */ }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = {
      contributionId: payload.contributionId,
      submitter: op.signerId,
      dims: payload.dims,
      summary: payload.summary,
      evidence: payload.evidence,
      submittedAt: nowMs,
    };
    // Explanation record for the submit decision (invariant: every decision
    // emits an explanation record). Element is the JSON record; tag is the
    // submitter so records are attributable.
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(record), op.signerId);
    state.setAdd(STATE_NAMES.contributions, payload.contributionId, op.signerId);
    return 0;
  };
}
```

Note the status register is a plain `state.setRegister` — it does not require a prior `node.addRegister` on the real wasm node (registers are auto-created on first write in the handler environment used by both mirrors; if a validation error says otherwise at execution time, add `node.addRegister(CONTRIB_NAMES.status(...), 0)` in a try/catch above it, matching the pattern in `makeCreateProposalHandler`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full existing suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: submit_contribution op records contribution with explanation record"
```

---

### Task 3: verify_contribution handler with RES payment rules

**Files:**
- Modify: `shared/src/handlers.ts` (add `makeVerifyContributionHandler`)
- Test: `server/test/contribution.test.ts`

Semantics (from `docs/contribution-economy`):
- C_18 Moon: the **verifier** earns `RES_CONFIG.verificationCheckCredit` for completing a check, **regardless of direction** (pass or reject) — "Rewards finishing verification checks in either direction."
- A verifier cannot verify their own contribution (`payload.submitter === op.signerId` rejected).
- On `pass`, the **submitter** is paid by the class-specific outcome rules of their claimed implemented dimensions (`paymentFor`), and the corresponding dimension tally grows by the match weight (delta formula, phase-1 simplification).
- The status register flips 0 → 1 (accepted) or 0 → 2 (rejected). Re-verifying is rejected (no double payment).
- The verification decision appends an explanation record with `calibrationVersion`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/contribution.test.ts`:

```typescript
describe('verify_contribution handler', () => {
  function setupSubmitted(state: MockState, node: MockNode, signer = 'alice', contributionId = 'c-1') {
    state.setAdd(STATE_NAMES.members, signer, signer);
    state.setAdd(STATE_NAMES.members, 'bob', 'bob');
    const handler = makeSubmitContributionHandler(node);
    handler(state, makeOp('submit_contribution', signer, submitOp({ contributionId })));
    state.setRegister(`res:${signer}`, 0);
    state.setRegister(`res:bob`, 0);
  }

  it('pays the verifier on a completed check regardless of direction', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node);
    const verify = makeVerifyContributionHandler(node);

    expect(verify(state, makeOp('verify_contribution', 'bob', {
      contributionId: 'c-1', submitter: 'alice', dims: { '2': 1 }, pass: false, reason: 'No record link',
    } as VerifyContributionPayload))).toBe(0);
    expect(state.getRegister(`res:bob`)).toBe(RES_CONFIG.verificationCheckCredit);
    expect(state.getRegister(`res:alice`)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(2);
  });

  it('on pass, pays the submitter per implemented dim rule and updates dimension tallies', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-multi');
    const verify = makeVerifyContributionHandler(node);

    expect(verify(state, makeOp('verify_contribution', 'bob', {
      contributionId: 'c-multi', submitter: 'alice', dims: { '1': 1, '2': 0.5, '9': 1 }, pass: true, reason: 'Real artifact, durable record',
    } as VerifyContributionPayload))).toBe(0);
    const expected = RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5;
    expect(state.getRegister(`res:alice`)).toBe(expected);
    expect(state.getRegister(`dim:alice:c1`)).toBe(1);
    expect(state.getRegister(`dim:alice:c2`)).toBe(0.5);
    expect(state.getRegister(`dim:alice:c9`)).toBe(undefined); // non-implemented dim: tally never set
    expect(state.getRegister(CONTRIB_NAMES.status('c-multi'))).toBe(1);
    expect(state.getRegister(`res:bob`)).toBe(RES_CONFIG.verificationCheckCredit);
  });

  it('rejects a verifier verifying their own contribution', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-self');
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'alice', {
      contributionId: 'c-self', submitter: 'alice', dims: { '2': 1 }, pass: true, reason: 'self',
    } as VerifyContributionPayload))).toBe(-1);
  });

  it('rejects a second verification (no double payment)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-twice');
    const verify = makeVerifyContributionHandler(node);
    const verdict = { contributionId: 'c-twice', submitter: 'alice', dims: { '2': 1 }, pass: true, reason: 'ok' } as VerifyContributionPayload;
    expect(verify(state, makeOp('verify_contribution', 'bob', verdict))).toBe(0);
    const bobBalance = state.getRegister(`res:bob`);
    expect(verify(state, makeOp('verify_contribution', 'carol', verdict))).toBe(-1);
    expect(state.getRegister(`res:bob`)).toBe(bobBalance);
  });

  it('rejects verification of an unknown contribution', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'bob');
    state.setRegister('res:bob', 0);
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', {
      contributionId: 'ghost', submitter: 'alice', dims: { '2': 1 }, pass: true, reason: 'x',
    } as VerifyContributionPayload))).toBe(-1);
  });

  it('rejects when submitter is unknown or invalid dims presented', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-guards');
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', {
      contributionId: 'c-guards', submitter: 'ghost-user', dims: { '2': 1 }, pass: true, reason: 'x',
    } as VerifyContributionPayload))).toBe(-1);
    expect(verify(state, makeOp('verify_contribution', 'bob', {
      contributionId: 'c-guards', submitter: 'alice', dims: { '22': 1 }, pass: true, reason: 'x',
    } as VerifyContributionPayload))).toBe(-1);
  });
});
```

Note: `MockState.getRegister` falls back to `undefined`→0 handling — its implementation returns `this.registers.get(name) ?? this.node.registers.get(name) ?? 0`, so `undefined` can't actually be observed through the mock. To make the "tally never set" assertion meaningful, change MockState's `getRegister` in `server/test/contribution.test.ts` to:

```typescript
  getRegister(name: string): number | undefined {
    return this.registers.has(name)
      ? this.registers.get(name)
      : this.node.registers.has(name)
        ? this.node.registers.get(name)
        : undefined;
  }
```

(Do NOT change `server/test/handlers.test.ts` — older tests rely on the 0-default.) Adjust the assertions above to `toBeUndefined()`/`not.toBeNull()` accordingly:

- `expect(state.getRegister(`dim:alice:c9`)).toBeUndefined();`
- all other register reads gain `as number` where needed, e.g. `expect(state.getRegister(`res:alice`) as number).toBe(expected)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contribution.test.ts`
Expected: FAIL — `makeVerifyContributionHandler` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `shared/src/handlers.ts` (imports: `VerifyContributionPayload` and `ContributionPayload` from `./types`; `paymentFor` from `./contribution`):

```typescript
export function makeVerifyContributionHandler(
  node: { addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: VerifyContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.submitter) ||
      !isNonEmptyString(payload.reason) ||
      typeof payload.pass !== 'boolean' ||
      !isValidDims(payload.dims)
    ) {
      return -1;
    }
    if (payload.submitter === op.signerId) {
      return -1; // C_18 anti-gaming: no self-verification
    }
    if (!state.setContains(STATE_NAMES.members, payload.submitter)) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.contributions, payload.contributionId)) {
      return -1;
    }
    const statusReg = CONTRIB_NAMES.status(payload.contributionId);
    if (state.getRegister(statusReg) !== 0) {
      return -1; // already settled; no re-verification, no double payment
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();

    // C_18 Moon: verification token per completed check, regardless of direction.
    const verifierBalance = state.getRegister(RES_NAMES.balance(op.signerId)) || 0;
    state.setRegister(RES_NAMES.balance(op.signerId), verifierBalance + RES_CONFIG.verificationCheckCredit, op.signerId);

    const payments: Record<string, number> = {};
    if (payload.pass) {
      for (const [dimKey, match] of Object.entries(payload.dims)) {
        const amount = paymentFor(Number(dimKey), match);
        if (amount <= 0) continue; // class-specific outcome rule not implemented in phase 1
        const submitterBalance = state.getRegister(RES_NAMES.balance(payload.submitter)) || 0;
        state.setRegister(RES_NAMES.balance(payload.submitter), submitterBalance + amount, op.signerId);
        payments[dimKey] = amount;
        // Delta C_i = Match_i × Outcome × Verification (phase-1: Calibration_i = 1).
        const dimIndex = Number(dimKey);
        const tallyReg = CONTRIB_NAMES.dimensionBalance(payload.submitter, dimIndex);
        const tally = state.getRegister(tallyReg) || 0;
        state.setRegister(tallyReg, dimensionDeltaFor(dimIndex, match) + tally, op.signerId);
      }
    }

    state.setRegister(statusReg, payload.pass ? 1 : 2, op.signerId);
    const explanation = {
      actionId: payload.contributionId,
      verification: { verifier: op.signerId, pass: payload.pass, reason: payload.reason, at: nowMs },
      payments,
      calibrationVersion: CALIBRATION_VERSION,
    };
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(explanation), op.signerId);
    return 0;
  };
}
```

Import `dimensionDeltaFor` and `CALIBRATION_VERSION` from `./contribution` alongside `paymentFor`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full existing suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: verify_contribution op pays verifier credit and submitter outcome bounties"
```

---

### Task 4: Switch voting to $RES balance and delete timed accrual

**Files:**
- Modify: `shared/src/handlers.ts:76-98` (remove `distributeTokens`), `shared/src/handlers.ts:141` and `460` (vote call sites), `shared/src/handlers.ts:483-502` (remove `makeSetTokenConfigHandler`), `shared/src/handlers.ts:514-515` (remove_member)
- Modify: `shared/src/policies.ts` (remove `TOKEN_CONFIG` accrual fields, `CONFIG_NAMES`, `TOKEN_NAMES.balance`, `TOKEN_NAMES.lastDistribution`; add `TIMING`)
- Modify: `shared/src/types.ts` (remove `SetTokenConfigPayload`, `TokenConfig`)
- Test: `server/test/handlers.test.ts` (update fund helper; delete accrual tests)

- [ ] **Step 1: Update the test fund helper and delete timed-accrual tests first (TDD — red)**

In `server/test/handlers.test.ts`, replace `initUser` (lines 124-127) with:

```typescript
function initUser(state: MockState, username: string, balance: number = 20) {
  // Phase-1: $RES balance is credited only by verified contributions; in unit
  // tests we simulate that by writing the balance register directly.
  state.setRegister(`res:${username}`, balance);
}
```

Delete the tests `distributes contribution tokens at the configured interval` (lines 199-213) and `honors custodian-configured distribution settings` (lines 319-335) entirely. Update the import on line 12 to remove `TOKEN_CONFIG` and `makeSetTokenConfigHandler` (and remove the corresponding `makeSetTokenConfigHandler` tests around lines 568-588 — the `set_token_config` policy test moves to Task 6 in `server/test/crabs.test.ts` as a *rejection* test: the op type is being deleted, so any submission must be rejected).

Run: `npm test -- handlers.test.ts`
Expected: FAIL — `distributeTokens` still accrues on `tokens:` registers while tests now fund `res:` registers (quadratic votes with balance-funded users return -1 because accrual against `res:` reads 0).

- [ ] **Step 2: Replace the vote call sites**

In `shared/src/handlers.ts` `makeVoteHandler` (line 141), replace:

```typescript
      const balance = distributeTokens(state, op.signerId, nowMs);
```

with:

```typescript
      const balance = state.getRegister(RES_NAMES.balance(op.signerId)) || 0;
```

Do the identical replacement in `makeCastRunoffVoteHandler` (line 460). Keep the surrounding quadratic-cost logic unchanged — it already tracks cumulative n² cost via mirror sets and never debits globally.

- [ ] **Step 3: Delete the timed-accrual machinery**

In `shared/src/handlers.ts`:
- Delete `distributeTokens` (lines 76-98).
- Delete `makeSetTokenConfigHandler` (lines 483-502) and its `SetTokenConfigPayload` import.
- In `makeRemoveMemberHandler` (lines 514-515), replace the two `TOKEN_NAMES.balance/lastDistribution` register writes with:

```typescript
    state.setRegister(RES_NAMES.balance(payload.username), 0, 'system');
```

In `shared/src/policies.ts`:
- Replace `TOKEN_CONFIG` (lines 3-8) with:

```typescript
export const TIMING: { defaultExpiryMs: number } = {
  defaultExpiryMs: 60 * 1000, // 1 minute for the demo
};
```

- In `TOKEN_NAMES` (lines 29-43), delete the `balance` and `lastDistribution` entries (the `tokens:`-prefixed mirror-set/vote-bookkeeping names stay).
- Delete `CONFIG_NAMES` (lines 49-52).

Then fix imports/usages: every `TOKEN_CONFIG` reference in `shared/src/handlers.ts` (proposal default expiry at line 66, election default expiry at line 261, runoff expiry at line 415) becomes `TIMING`; update the import block accordingly (`TIMING` in, `CONFIG_NAMES`/`TOKEN_CONFIG` out).

In `shared/src/types.ts`: delete `SetTokenConfigPayload` (lines 69-72) and `TokenConfig` (lines 83-88).

- [ ] **Step 4: Run the full suite to green**

Run: `npm test`
Expected: PASS — all remaining handler tests exercise quadratic voting funded by `res:` balances.

- [ ] **Step 5: Commit**

```bash
git add shared/src/handlers.ts shared/src/policies.ts shared/src/types.ts server/test/handlers.test.ts
git commit -m "feat!: pay votes from RES balance; delete timed token distribution and set_token_config"
```

(Note: `server/src/crabs.ts` and `client/src/dao.ts` still reference the deleted names and will fail to compile until Tasks 5 and 6 land. If CI requires a green compile at every commit, land Task 5 and Task 6 as `wip:` commits immediately after, or squash Tasks 4-6 in one commit — see Task 6 Step 7.)

---

### Task 5: Server DaoNode wiring for contribution ops and RES registers

**Files:**
- Modify: `server/src/crabs.ts` (policies, handler registration, register init, balance getter)
- Test: `server/test/crabs.test.ts` (rewrite `set_token_config` test for contribution ops)

- [ ] **Step 1: Write the failing real-wasm test**

In `server/test/crabs.test.ts`, replace the `set_token_config` policy test (lines 32-58) with two tests against the **real wasm** `DaoNode`:

```typescript
it('accepts submit_contribution and verify_contribution from a granted member', async () => {
  const dao = new DaoNode();
  await dao.init();
  const kp = await KeyPair.generate();
  dao.registerMember('alice', kp.publicKeyHex());
  const op = await buildSignedMemberOp(dao, 'alice', kp, 'submit_contribution', {
    contributionId: 'c-real-1',
    dims: { '1': 1 },
    summary: 'built the thing',
    evidence: 'repo#1',
  });
  dao.executeOperation(op);
  expect(dao.isContributionPending('c-real-1')).toBe(true);
});

it('rejects submit_contribution from an unregistered signer (policy role:member)', async () => {
  const dao = new DaoNode();
  await dao.init();
  const kp = await KeyPair.generate();
  const op = await buildSignedMemberOp(dao, 'nobody', kp, 'submit_contribution', {
    contributionId: 'c-real-2',
    dims: { '2': 1 },
    summary: 'x',
    evidence: 'y',
  });
  expect(() => dao.executeOperation(op)).toThrow();
});
```

Add the helper (mirroring whatever signing helper the existing tests use — if they build ops through `DaoNode.createAdminOperation`, member-key equivalents need this helper):

```typescript
async function buildSignedMemberOp(
  dao: DaoNode, username: string, kp: KeyPair, type: string, payload: object
): Promise<Operation> {
  const op = await Operation.create(type);
  op.signerId = username;
  op.nodeId = `test-${username}`;
  op.payload = new TextEncoder().encode(JSON.stringify(payload) + '\0');
  setOperationSignerKeyVersion(op, 3);
  await dao.node.sign(op, kp);
  return op;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- crabs.test.ts`
Expected: FAIL — `isContributionPending` missing / handlers not registered.

- [ ] **Step 3: Wire the server node**

In `server/src/crabs.ts`:
- Init (after line 35), replacing the two `CONFIG_NAMES` register declarations:

```typescript
    this.node.addORSet(STATE_NAMES.contributions);
```

(deleting the `CONFIG_NAMES.distributionInterval()/distributionRate()` declarations).

- Policies (lines 37-46): delete the `set_token_config` line; add:

```typescript
    this.node.setPolicy('submit_contribution', POLICIES.submit_contribution);
    this.node.setPolicy('verify_contribution', POLICIES.verify_contribution);
```

- Handler registration (lines 48-58): delete the `set_token_config` line; add:

```typescript
    this.node.registerHandlerJs('submit_contribution', makeSubmitContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('verify_contribution', makeVerifyContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
```

- `initTokenRegisters` (lines 80-83) becomes:

```typescript
  private initTokenRegisters(username: string) {
    try { this.node.addRegister(RES_NAMES.balance(username), 0); } catch (err) { /* ignore duplicate */ }
  }
```

(new members start with `$RES` balance 0 and earn via contributions — no seed grant, no `lastDistribution` register).

- Replace `getTokenBalance` (lines 122-124):

```typescript
  getResBalance(username: string): number {
    return this.node.getRegister(RES_NAMES.balance(username)) || 0;
  }

  getDimensionBalance(username: string, dimIndex: number): number {
    return this.node.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex)) || 0;
  }

  isContributionPending(contributionId: string): boolean {
    return this.node.getRegister(CONTRIB_NAMES.status(contributionId)) === 0 &&
      this.node.setContains(STATE_NAMES.contributions, contributionId);
  }

  getContributionStatus(contributionId: string): 'pending' | 'accepted' | 'rejected' | 'unknown' {
    if (!this.node.setContains(STATE_NAMES.contributions, contributionId)) return 'unknown';
    const status = this.node.getRegister(CONTRIB_NAMES.status(contributionId));
    return status === 1 ? 'accepted' : status === 2 ? 'rejected' : 'pending';
  }
```

Update the import block for the new/renamed names (`CONTRIB_NAMES`, `RES_NAMES`, `POLICIES`, `STATE_NAMES`; drop `CONFIG_NAMES`, `TOKEN_CONFIG`) and the new handler factories (`makeSubmitContributionHandler`, `makeVerifyContributionHandler`; drop `makeSetTokenConfigHandler`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- crabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. (`server/test/handlers.test.ts` still compiles — it only uses shared handler code.)

- [ ] **Step 6: Commit**

```bash
git add server/src/crabs.ts server/test/crabs.test.ts
git commit -m "feat(server): register contribution handlers and RES balance registers on DaoNode"
```

---

### Task 6: Client BrowserDao mirror wiring

**Files:**
- Modify: `client/src/dao.ts` (policies/handler registration, register init, sign methods, mirrors, getters; remove `setTokenConfig`/`getDistributionConfig`/old init)

The browser mirror executes every op, so it must register the same handlers. The client **does not register custodian-only policies** it can't exercise… it registers all today (dao.ts:84); follow suit.

- [ ] **Step 1: Mirror registration and init**

In `client/src/dao.ts`:

- Init block (lines 62-68): delete the two `CONFIG_NAMES` register declarations (lines 67-68); add:

```typescript
    this.node.addORSet(STATE_NAMES.contributions);
```

- Policies (lines 70-85): delete `set_token_config`; add:

```typescript
    this.node.setPolicy('submit_contribution', POLICIES.submit_contribution);
    this.node.setPolicy('verify_contribution', POLICIES.verify_contribution);
```

- Handlers (lines 75-93): delete the `set_token_config` handler; add:

```typescript
    this.node.registerHandlerJs('submit_contribution', makeSubmitContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('verify_contribution', makeVerifyContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
```

- `initTokenRegisters` (lines 155-158) becomes identical to the server version (`addRegister(RES_NAMES.balance(username), 0)`, no `lastDistribution`).

- [ ] **Step 2: Sign methods and mirrors**

Add sign methods next to the existing ones (mirroring `castRunoffVote`, dao.ts:131-133):

```typescript
  async submitContribution(userId: string, payload: ContributionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('submit_contribution', userId, JSON.stringify(payload));
  }

  async verifyContribution(userId: string, payload: VerifyContributionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('verify_contribution', userId, JSON.stringify(payload));
  }
```

Delete `setTokenConfig` (lines 135-137) and the `SetTokenConfigPayload` import.

Add a contributions mirror field next to `proposals` (line 173):

```typescript
  private contributions = new Map<string, { record: ContributionPayload; submitter: string; submittedAt: number }>();
```

In `executeRemote` (after the proposals parse at line 191-194), add:

```typescript
      await this.mirrorContributionState(op);
```

and implement (same JSON-parse pattern as `mirrorElectionState`, dao.ts:246):

```typescript
  private async mirrorContributionState(op: any): Promise<void> {
    if (op.type !== 'submit_contribution' && op.type !== 'verify_contribution') {
      return;
    }
    let payload: any = null;
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      payload = JSON.parse(json.replace(/\0$/, ''));
    } catch {
      return;
    }
    if (op.type === 'submit_contribution') {
      if (typeof payload.contributionId === 'string') {
        this.contributions.set(payload.contributionId, {
          record: payload as ContributionPayload,
          submitter: op.signerId,
          submittedAt: this.getNodeTimeMs(),
        });
      }
      return;
    }
    const entry = this.contributions.get(payload.contributionId);
    if (entry) {
      (entry as any).verifiedBy = op.signerId;
      (entry as any).verdict = payload.pass;
      (entry as any).verdictReason = payload.reason;
    }
  }

  getContributions(): Array<{ record: ContributionPayload; submitter: string; submittedAt: number }> {
    return Array.from(this.contributions.values());
  }
```

(For UI display convenience the verdict fields live on the entry; the authoritative status remains the CRABS register.)

- [ ] **Step 3: Getters**

Replace `getTokenBalance` (lines 305-307) and `getDistributionConfig` (lines 378-383):

```typescript
  getResBalance(username: string): number {
    return this.node.getRegister(RES_NAMES.balance(username)) || 0;
  }

  getDimensionBalance(username: string, dimIndex: number): number {
    return this.node.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex)) || 0;
  }

  getContributionStatus(contributionId: string): 'pending' | 'accepted' | 'rejected' | 'unknown' {
    if (!this.node.setContains(STATE_NAMES.contributions, contributionId)) return 'unknown';
    const status = this.node.getRegister(CONTRIB_NAMES.status(contributionId));
    return status === 1 ? 'accepted' : status === 2 ? 'rejected' : 'pending';
  }
```

Update imports (add `RES_NAMES`, `CONTRIB_NAMES`, `makeSubmitContributionHandler`, `makeVerifyContributionHandler`, `ContributionPayload`, `VerifyContributionPayload`; drop `CONFIG_NAMES`, `TOKEN_CONFIG`, `SetTokenConfigPayload`, `makeSetTokenConfigHandler`).

- [ ] **Step 4: Compile check (client has no jest unit tests — this is its verification)**

Run: `npx tsc -p client/tsconfig.json --noEmit` (or the project's check command if stricter: `npm run build:client`)
Expected: PASS with no errors.

- [ ] **Step 5: Run the full server suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/dao.ts
git commit -m "feat(client): mirror submit/verify contribution ops and RES balance in BrowserDao"
```

---

### Task 7: UI — contribution flow replaces token accrual surfaces

**Files:**
- Modify: `client/ui.html` (or wherever the token-config and token-balance elements live — locate `token-config-form` usage in `client/index.html`) — remove custodian token-config form; add contribution submit form and verification card list
- Modify: `client/src/ui.ts` (remove `onSetTokenConfig`/`renderCustodianControls` config section; rename token getters; add `onSubmitContribution`, `onVerifyContribution`, `renderContributions`)

- [ ] **Step 1: Replace the custodian token-config form (HTML)**

In `client/index.html`, delete the `<form id="token-config-form">` block (interval/rate inputs) and replace with:

```html
<form id="contribution-form">
  <h3>Submit a contribution</h3>
  <input id="contribution-summary" placeholder="What did you make or record?" required />
  <input id="contribution-evidence" placeholder="Evidence (record id, URL, commit…)" required />
  <fieldset class="contribution-dims">
    <label><input type="checkbox" value="1" checked /> C_1 Building (bounty 12)</label>
    <label><input type="checkbox" value="2" /> C_2 Recording (base 3)</label>
  </fieldset>
  <button type="submit">Submit contribution</button>
</form>
<section id="contributions-list"></section>
```

(If the existing index.html uses a different form/container convention, follow it — this PoC's UI is plain DOM built in `ui.ts`; the only hard requirement is the element ids referenced below exist.)

- [ ] **Step 2: Wire ui.ts handlers**

In `client/src/ui.ts`:

- Delete `onSetTokenConfig` (lines 789-812) and its submit-button listener (lines 80-84), and the config form section of `renderCustodianControls` (lines 969-982: remove the `configForm`, `config`, `intervalInput`, `rateInput` references — keep the `remove-controls` member list logic).
- Delete the token-config form binding; add binding next to the other `addEventListener` wiring (~line 78):

```typescript
    const contributionForm = document.getElementById('contribution-form') as HTMLFormElement | null;
    contributionForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onSubmitContribution();
    });
```

- Add the handler methods (follow the `onCastRunoffVote` try/submit/safeExecuteRemote/finally pattern at ui.ts:925):

```typescript
  private async onSubmitContribution() {
    if (!this.dao || !this.wallet || this.submitting) return;
    const summary = this.inputValue('contribution-summary');
    const evidence = this.inputValue('contribution-evidence');
    const dims: Record<string, number> = { '2': 1 }; // recording is the default class
    const building = (document.getElementById('contribution-form')!.querySelector('input[value="1"]') as HTMLInputElement)?.checked;
    if (building) dims['1'] = 1;
    if (!summary || !evidence) {
      this.setStatus('Summary and evidence are required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const payload = {
        contributionId: crypto.randomUUID(),
        dims,
        summary,
        evidence,
      };
      const bytes = await this.dao.submitContribution(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Contribution submitted — awaiting verification.', 'success');
      this.clearForm('contribution-form');
    } catch (err) {
      this.setStatus(`Contribution error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onVerifyContribution(contributionId: string, submitter: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    if (submitter === this.wallet.username) return;
    const record = this.dao.getContributions().find((c) => c.record.contributionId === contributionId);
    if (!record) return;
    const pass = confirm('Accept this contribution? OK = accept, Cancel = reject. A written reason follows.');
    const reason = prompt('Written reason for your verification:') ?? '';
    if (!reason.trim()) {
      this.setStatus('A written reason is required for every verification.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.verifyContribution(this.wallet.username, {
        contributionId, submitter, dims: record.record.dims, pass, reason,
      });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Verification recorded (+${RES_CONFIG.verificationCheckCredit} $RES).`, 'success');
    } catch (err) {
      this.setStatus(`Verification error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }
```

- [ ] **Step 3: Render contributions and rename balance surfaces**

Add `renderContributions()` to the demo-clock refresh list (`startDemoClock`, ui.ts:91-105). Implementation: list `this.dao.getContributions()` newest-first; each card shows summary, dims, submitter, and status via `this.dao.getContributionStatus(id)`; pending contributions with `submitter !== this.wallet.username` get a "Verify" button wired to `onVerifyContribution`.

Rename every token surface to `$RES` (read via `getResBalance`):
- `renderTokenBalance` (ui.ts:1003-1008): `el.textContent = `${balance} $RES earned`;`
- quadratic card line (ui.ts:615): `Tokens used here:` → `Quadratic cost here:` and `Balance: ${this.dao.getResBalance(...)}`
- member badge (ui.ts:676): `` `$RES ${this.dao.getResBalance(...)}` ``
- runoff cost line (ui.ts:930): same rename using `getResBalance`.

- [ ] **Step 4: Build the client**

Run: `npm run build:client`
Expected: compiles clean.

- [ ] **Step 5: Manual browser verification (dev server)**

Run: `npm run dev` then open the client URL in two browser windows:
1. Register `alice` and `bob` in separate windows.
2. As `alice`, submit a contribution (summary + evidence, C_1 checked).
3. As `bob`, verify-accept it → bob's badge shows +2 `$RES`, alice's shows +12.
4. As alice, cast a quadratic vote (cost 1) → succeeds; cast repeatedly until balance blocks (cumulative 5 > 12-1=11… after two votes balance 12-5 spent → third vote cost 5+... blocked at cumulative 14 > 12) — verify the gating shows and blocks.
5. Self-verification is impossible in the UI (alice sees no Verify button on her own card).

Expected: balances only move through verified contributions; nothing accrues over time (wait > 30s with no ops and re-read balance — unchanged).

- [ ] **Step 6: Update the e2e voting script**

`test-voting-browser.js` (~lines 109-112) drives the custodian token-config form — delete that section and (if the script asserts balances) switch its reads to the contribution flow (submit + verify once to fund votes). Keep the change minimal: the goal of this task's e2e edit is "script no longer touches deleted UI".

- [ ] **Step 7: Commit**

```bash
git add client/index.html client/src/ui.ts test-voting-browser.js
git commit -m "feat(ui): contribution submit/verify flow replaces token-config accrual surfaces"
```

---

### Task 8: Hydration, demo bootstrap, and suite-wide fixes

**Files:**
- Modify: `server/test/hydration.test.ts` (add token-register assertions)
- Modify: any remaining `TOKEN_NAMES.balance` / `lastDistribution` / `initTokenRegister*` references (grep-driven)

- [ ] **Step 1: Grep for stragglers**

Run: `grep -rn "distributeTokens\|last_dist\|distribution_interval\|distribution_rate\|set_token_config\|initialTokens\|distributionIntervalMs\|distributionRate\|TOKEN_NAMES.balance\|lastDistribution\|getTokenBalance\|SetTokenConfig" shared server client --include='*.ts'`
Expected: only intended references remain (none of the deleted names). Fix every hit: rename balance reads to `getResBalance`/`RES_NAMES.balance`, etc.

- [ ] **Step 2: Add hydration assertions for the new registers**

Append a test to `server/test/hydration.test.ts` that: registers a member, submits + accepts a contribution via signed ops, snapshots nothing, re-runs `hydrateDao` on the same WaveDB log, and asserts `getResBalance` and `getDimensionBalance` survive restart (their values come purely from op replay). Use the same op-building approach as `server/test/crabs.test.ts`.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/test/hydration.test.ts
git commit -m "test: contribution balances survive hydrateDao op-log replay"
```

---

### Task 9: Docs update and invariant walk-through

**Files:**
- Modify: `docs/contribution-economy/README.md` (note which invariants the running code now honors and which are deferred)
- Modify: `client/index.html` demo-help text if it mentions timed tokens (grep `tokens` / `distribution`)

- [ ] **Step 1: Update docs/contribution-economy/README.md**

Add a section at the bottom:

```markdown
## Binding to the reference implementation (2026-09-30)

The reference app in this repo now pays `$RES` through contribution workflow
outcome rules instead of timed accrual:

- Implemented in `shared/src/handlers.ts`: `submit_contribution` (master
  lifecycle record + explanation record), `verify_contribution` (C_18 Moon
  verifier credit per completed check, submitter outcome bounties on
  acceptance, 22-dimension tally update, calibration-versioned explanation
  record).
- Payment rules live in `shared/src/contribution.ts` (`DIMENSIONS` registry.
  Phase 1 implements C_1 Magician (building bounty), C_2 Priestess (recording
  base credit), C_18 Moon (verifier credit, either direction).
- Timed accrual (`distributeTokens`), the `set_token_config` custodian op, and
  the initial seed grant are deleted; voting spends the `$RES` balance with the
  same quadratic mechanics.
- Deferred (open issues, invariants not yet honored end-to-end): tiered
  verification (Tier 1 random audits, Tier 2 dual-reviewer with
  conflict-of-interest checks, Tier 3 appeal panel), harm checks, retrieval
  bonuses (C_2 usage bonus), round spine C_10/C_20/C_21 and `$RCT`
  aggregation, null-vs-verified-zero preservation in the 22-vector, and the
  payload-attested dims/submitter trust in `verify_contribution`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/contribution-economy/README.md
git commit -m "docs: record contribution-economy binding to running implementation"
```

---

## Self-review notes

- Spec coverage: master lifecycle submit→verify→pay→explanation (Tasks 2-3), $RES-outcome-only payment (Tasks 3-4, no seed grant), 22-vector tallies for implemented dims (Task 3), votes-from-balance (Task 4), register/hydration consistency (Tasks 5-8), UI pay-on-outcome surfaces (Task 7), docs (Task 9). Round spine, $RCT aggregation, and 19 remaining dimensions are explicitly out of scope (future issues).
- Open question the plan consciously locks in: new members start at $RES 0 (spec: "$RES paid only when outcome rules fire"); the demo bootstrap is that a fresh member can verify others' contributions to earn immediately.
- Number scale (verification 2, building 12, recording 3) is demo-tuned so a fresh member's first contribution covers their first quadratic votes; tune later with real calibration versions.