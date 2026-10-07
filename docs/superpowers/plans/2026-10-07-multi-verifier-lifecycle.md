# Multi-Verifier Lifecycle Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement phase 3 per `docs/superpowers/specs/2026-10-07-multi-verifier-lifecycle-design.md` — two-verifier review for C_1 contributions (schema-declared `all-parties` reviewer counts, legacy v1 contributions keep single-verify), the reciprocity conflict guard, the `appeal_verdict` op (rejected contributions re-open once, status 3), and verifier-accuracy registers with UI.

**Architecture:** Schemas stay static shared code — the C_1 verify step's requirement becomes `{mode: 'all-parties', count: 2}` under schema version 'v2', with legacy 'v1' resolution kept for already-submitted contributions via a new `schemaForRecord(schemaVersion, dims)`. The verify handler (the only place the lifecycle advances) gains: status 0-or-3 gate, reciprocity checks from `recip:` sets (handler-enforced, deterministic), per-verifier accuracy counters, and the existing isFinal/final-requirement acceptance path handles two verifiers without any new payment machinery. The appeal op rewinds the lifecycle positionally (verify step = index 1 in every current schema shape). `settle_contribution` gains a payload-attested `verifiers` list that increments upheld-accuracy — the same documented PoC trust class as dims/submitter.

**Tech Stack:** TypeScript, crabs-wasm (CRABS), WaveDB, Vite/esbuild client, Jest, Playwright e2e.

---

## Baseline (assume at execution start)

- HEAD of master: phase-2 complete (8 suites / 108 tests green; final review READY_TO_CLOSE; pushed to origin at 6f974d9).
- Current shared structure: `shared/src/contribution.ts` (DIMENSIONS, paymentFor, dimensionDeltaFor, EvidenceRef/validateEvidenceRef, CONTENT_LIMITS, StepDef/DimensionSchema with SCHEMA_VERSION='v1', SUBMIT/VERIFY/SETTLE step consts (frozen), DEFAULT_SCHEMA [submit→verify], SCHEMAS C_1/C_2/C_18 [submit→verify→settle], schemaForDims, stepPaymentsFor), `shared/src/round.ts` (spine stages, salient masks, aggregation, derivedVoteBalance, calibration maps), `shared/src/handlers.ts` (makeSubmit/Verify/SettleContributionHandler + spine + calibration + governance handlers), `shared/src/wizard.ts` (wizardModel/ContributionFacts), `shared/src/policies.ts` (vocab + policies, OR-widened).
- Wasm truths (pinned in tests): declare-before-write everywhere (`resource_not_found`); re-declare throws `duplicate_operation` without resetting; undeclared `getRegister` → 0 (MockState in contribution.test.ts returns undefined — handlers coalesce); explanation records tagged deterministic `{stepId}:{signer}` or `alpha:{n}`.
- Verify handler's current shape (by function, exact names may differ slightly — grep before editing): validates payload (non-empty contributionId/submitter/stepId/reason + boolean pass + isValidDims) → no-self → member/exists checks → `status === 0` + integer step → schemaForDims(payload.dims) step match → per-check actor credit (every completion) → counter bump → reject: status 2 + record → pass+final: payments/tallies/advance-or-accepted → records.
- Test file conventions: `server/test/contribution.test.ts` (local MockNode/MockState getRegister→number|undefined, `run()` cast helper, setupMembers/submitOp/verifyOp/settleOp/setupSubmitted/setupAtSettle/setupSpineReady helpers, allSetElements), `server/test/wizard.test.ts`, `server/test/round.test.ts`, `server/test/crabs.test.ts` (real wasm + buildSignedMemberOp keyVersion-aware + admin/custodian patterns), `server/test/hydration.test.ts`, `server/test/handlers.test.ts` (its own MockState getRegister→0-default; salient voting funding via seedTally + mask registrations).
- CRABS policy enforcement: ops without a registered policy throw `unauthorized`. New member-ops take `'role:member OR role:custodian'`.

---

### Task 1: Schema v2 + legacy resolution (`schemaForRecord`) and status 3 in the wizard model

**Files:**
- Modify: `shared/src/contribution.ts`
- Modify: `shared/src/wizard.ts`
- Modify: `shared/src/types.ts` (VerifyContributionPayload gains optional `schemaVersion`)
- Test: `server/test/round.test.ts` stays untouched; extend `server/test/contribution.test.ts` (schemas section) and `server/test/wizard.test.ts`

- [ ] **Step 1: Tests first (red)** — extend the `step schemas` describe in `server/test/contribution.test.ts`:

```typescript
import {
  schemaForRecord, STATUS_PENDING, STATUS_ACCEPTED, STATUS_REJECTED, STATUS_APPEALED,
  SCHEMA_VERSION_NUMBERS, KNOWN_SCHEMA_VERSIONS,
} from '../../shared/src/contribution';

describe('schema v2 (two-verifier C_1) and legacy resolution', () => {
  it('exposes status constants (status register values)', () => {
    expect(STATUS_PENDING).toBe(0);
    expect(STATUS_ACCEPTED).toBe(1);
    expect(STATUS_REJECTED).toBe(2);
    expect(STATUS_APPEALED).toBe(3);
  });

  it('v2 default: C_1 requires all-parties count 2; C_2/C_18 stay single', () => {
    for (const dim of [2, 18]) {
      expect(SCHEMAS.get(dim)!.steps[1].requirement).toEqual({ mode: 'single', count: 1 });
    }
    const c1 = SCHEMAS.get(1)!.steps[1];
    expect(c1.requirement).toEqual({ mode: 'all-parties', count: 2 });
  });

  it('schemaForRecord v2 vs v1: two-verifier C_1 only in v2; legacy resolves single-verify', () => {
    const v2c1 = schemaForRecord('v2', { '1': 1 });
    expect(v2c1.steps[1].requirement).toEqual({ mode: 'all-parties', count: 2 });
    const v1c1 = schemaForRecord('v1', { '1': 1 });
    expect(v1c1.steps[1].requirement).toEqual({ mode: 'single', count: 1 });
    expect(v1c1.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']); // legacy 3-step
    expect(schemaForRecord('v1', { '9': 1 }).schemaVersion).toBe('v1'); // legacy default: 2-step, dimIndex -1
    expect(() => schemaForRecord('v9', { '1': 1 })).toThrow(); // unknown version → callers reject
  });

  it('known-schema-version map covers v1 and v2 only', () => {
    expect([...SCHEMA_VERSION_NUMBERS.keys()].sort()).toEqual(['v1', 'v2']);
    expect(SCHEMA_VERSION).toBe('v2');
    expect(KNOWN_SCHEMA_VERSIONS('v1')).toBe(true);
    expect(KNOWN_SCHEMA_VERSIONS('v2')).toBe(true);
    expect(KNOWN_SCHEMA_VERSIONS('v0')).toBe(false);
  });
});
```

WIZARD: extend `server/test/wizard.test.ts`:

```typescript
  it('status 3 (appealed) renders like pending on the verify step + appealed flag', () => {
    const m = wizardModel(schema, c1Facts(1, { submit: 1 }, 3), 'bob');
    expect(m.outcome).toBe('pending');
    expect(m.appealed).toBe(true);
    expect(m.currentStepIndex).toBe(1);
    expect(m.steps[1].state).toBe('current');
  });

  it('unknown schema versions render read-only; known legacy v1 facts render normally', () => {
    const legacyModel = wizardModel(schemaForRecord("v1", { "1": 1 }), c1Facts(1, { submit: 1 }), 'alice');
    expect(legacyModel.readOnly).toBe(false);
```

(Adapt the exact call to the actual v1 schema instance exposed for tests — see implementation.)

- [ ] **Step 2: Run** both test files → FAIL (new exports missing).

- [ ] **Step 3: Implement**

`shared/src/contribution.ts`:

```typescript
// Contribution status register values.
export const STATUS_PENDING = 0 as const;
export const STATUS_ACCEPTED = 1 as const;
export const STATUS_REJECTED = 2 as const;
export const STATUS_APPEALED = 3 as const; // set by appeal_verdict; verify accepts 3 like 0

export const SCHEMA_VERSION = 'v2' as const;

// Known schema versions (unknown → wizardModel renders read-only).
export const SCHEMA_VERSION_NUMBERS = new Map<string, number>([['v1', 1], ['v2', 2]] as const);
export function KNOWN_SCHEMA_VERSIONS(version: string): boolean {
  return SCHEMA_VERSION_NUMBERS.has(version);
}

const SINGLE_VERIFY_STEP: StepDef = VERIFY_STEP; // existing verify step def (single, pays as today)

// v2's heavier C_1 verification: two distinct verifiers, all-parties.
export const C1_VERIFY_V2: StepDef = {
  ...VERIFY_STEP,
  requirement: { mode: 'all-parties', count: 2 },
};

// Legacy v1 schemas (single-verify everywhere) — kept so contributions
// submitted before v2 keep verifying under the rules they were submitted under.
const LEGACY_DEFAULT_SCHEMA: DimensionSchema = {
  dimIndex: -1,
  schemaVersion: 'v1',
  steps: [SUBMIT_STEP, VERIFY_STEP],
};
const LEGACY_SCHEMAS: Map<number, DimensionSchema> = new Map();
for (const dimIndex of [1, 2, 18]) {
  LEGACY_SCHEMAS.set(dimIndex, { dimIndex, schemaVersion: 'v1', steps: [SUBMIT_STEP, VERIFY_STEP, SETTLE_STEP] });
}
// v2 schemas (current publication state)
export const V2_DEFAULT_SCHEMA: DimensionSchema = {
  dimIndex: -1,
  schemaVersion: 'v2',
  steps: [SUBMIT_STEP, VERIFY_STEP],
};
export const V2_SCHEMAS: Map<number, DimensionSchema> = new Map();
for (const dimIndex of [1, 2, 18]) {
  V2_SCHEMAS.set(dimIndex, {
    dimIndex,
    schemaVersion: 'v2',
    steps: [SUBMIT_STEP, dimIndex === 1 ? C1_VERIFY_V2 : VERIFY_STEP, SETTLE_STEP],
  });
}
// SCHEMAS exported earlier now points at the v2 set (rename kept: SCHEMAS = V2_SCHEMAS)
```

Existing exports referenced everywhere (`DEFAULT_SCHEMA`, `SCHEMAS`) must KEEP their names but now resolve to v2: `export const SCHEMAS = V2_SCHEMAS; export const DEFAULT_SCHEMA = V2_DEFAULT_SCHEMA;` (importers don't change). `schemaForDims` unchanged (v2 only).

Remove the old `buildSchemaVersion` string constant 'v1' — everywhere `SCHEMA_VERSION` was referenced 'v1' (e.g. submit validation `payload.schemaVersion !== SCHEMA_VERSION`) must now accept BOTH:

```typescript
const versionKnown = typeof payload.schemaVersion === 'string' && KNOWN_SCHEMA_VERSIONS(payload.schemaVersion);
```

— the submit handler accepts 'v1' AND 'v2' (legacy allowed; nothing breaks; new submissions use 'v2' and the UI supplies 'v2' via `SCHEMA_VERSION`).

`schemaForRecord`:

```typescript
export function schemaForRecord(schemaVersion: string, dims: Record<string, number>): DimensionSchema {
  const wired = Object.keys(dims)
    .map(Number)
    .filter((i) => (schemaVersion === 'v1' ? LEGACY_SCHEMAS : SCHEMAS).has(i))
    .sort((a, b) => a - b);
  const map = schemaVersion === 'v1' ? LEGACY_SCHEMAS : SCHEMAS;
  return wired.length > 0 ? map.get(wired[0])! : (schemaVersion === 'v1' ? LEGACY_DEFAULT_SCHEMA : DEFAULT_SCHEMA);
}
```

(Rejecting unknown versions happens in the CALLERS: submit validates `KNOWN_SCHEMA_VERSIONS`; verify/complete validate too. The wizard's read-only path becomes the fallback: `wizardModel`'s readOnly condition changes from `schema.schemaVersion !== SCHEMA_VERSION` to `!SCHEMA_VERSION_NUMBERS.has(schema.schemaVersion) || facts.status === -1`.)

`shared/src/wizard.ts`: `WizardModel` gains `appealed?: boolean` (set when `facts.status === 3`; rendered like pending) — and the readOnly condition per above. Export a convenience `statusPendingLike(s) = s === 0 || s === 3` if the implementation wants a named predicate — prefer direct comparisons per YAGNI.

`shared/src/types.ts`: `VerifyContributionPayload` gains optional `schemaVersion?: string` (defaults to SCHEMA_VERSION in the handler).

- [ ] **Step 4: Run** both test files PASS; full `npm test` PASS (all existing suites stay green — legacy v1 facts render; the existing tests use SCHEMA_VERSION 'v2' — CHECK: the existing submit tests submit with `schemaVersion: SCHEMA_VERSION` (now 'v2') — those tests should still pass IF schemaForDims (used by the handler at verify time — NOW schemaForRecord(payload.schemaVersion ?? 'v2'...)) resolves correctly; the existing verify tests pass `dims` only → schemaVersion defaults to current → v2 behavior. The two-verifier C_1 requirement change BREAKS the existing C_1 lifecycle tests (a single bob-verify on C_1 no longer finalizes). FIX: rewrite the affected C_1 tests to the v2 semantics (two verifiers) — list them by grepping for tests with `dims: { '1'... and 3-step assertions. The tests 'on pass at the final requirement...' (wizard-era C_1 with dims 1/2/9 single bob-verify) must be updated: bob + carol verify (two verify ops), THEN assert. Where a test intends 'C_2 with match 0.5' semantics (single-verify), split the dims so the C_1 two-verify path is exercised correctly. Keep test INTENT; update FLOW. Report each rewritten test.

- [ ] **Step 5: Commit**

```bash
git add shared/src/contribution.ts shared/src/wizard.ts shared/src/types.ts server/test/contribution.test.ts server/test/wizard.test.ts
git commit -m "feat: schema v2 — two-verifier C_1 review; legacy v1 resolution; appealed status in wizard model"
```

---

### Task 2: Reciprocity guard + per-verifier accuracy in the verify handler

**Files:**
- Modify: `shared/src/policies.ts` (RECIP_NAMES/CHECK_NAMES vocab; verify payload validation gains priorVerifiers)
- Modify: `shared/src/handlers.ts` (verify handler)
- Modify: `shared/src/types.ts` (VerifyContributionPayload gains `priorVerifiers?: string[]`)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Vocab** — add to `shared/src/policies.ts`:

```typescript
export const RECIP_NAMES = {
  // Members who have verified this submitter at least once (per-pair once +
  // mutual bar). Elements = verifier usernames, tags = contributionId-unique.
  verifiedBy: (submitter: string) => `recip:${submitter}`,
} as const;

export const CHECK_NAMES = {
  total: (username: string) => `check:${username}:total`,
  upheld: (username: string) => `check:${username}:upheld`,
} as const;
```

Type: `VerifyContributionPayload` gains `priorVerifiers?: string[]` (client-attested list of verifiers on earlier completions of this step — the handler refuses the signer when they appear; document in a comment).

- [ ] **Step 2: Tests first (red)** — append to `server/test/contribution.test.ts`:

```typescript
describe('verify reciprocity and accuracy', () => {
  it('blocks the per-pair repeat: bob cannot verify the same submitter twice', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-recip1', { '2': 1 });
    state.setAdd(STATE_NAMES.members, 'carol', 'carol');
    const verify = makeVerifyContributionHandler(node);
    // C_2 single verify: bob completes it once.
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({} )))).toBe(0);
    // next contribution from alice: bob is blocked by the reciprocity set.
    setupSubmitted(state, node, 'alice', 'c-recip2', { '2': 1 });
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-recip2' })))).toBe(-1);
    expect(state.setContains(RECIP_NAMES.verifiedBy('alice'), 'bob')).toBe(true); // pin the guard set
  });

  it('blocks the mutual loop: alice cannot verify bob after bob verified alice', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-loop1', { '2': 1 });
    state.setAdd(STATE_NAMES.members, 'bob', 'bob');
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({})))).toBe(0);
    // setup bob's own contribution verified by alice → allowed (alice hasn't verified bob)
    setupSubmitted(state, node, 'bob', 'c-loop2', { '2': 1 });
    expect(verify(state, makeOp('verify_contribution', 'alice', verifyOp({ contributionId: 'c-loop2', submitter: 'bob' })))).toBe(0);
    // third round: bob tries alice's new contribution — mutual loop
    setupSubmitted(state, node, 'alice', 'c-loop3', { '2': 1 });
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-loop3' })))).toBe(-1);
  });

  it('a signer appearing in priorVerifiers is rejected (all-parties distinct actors)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-both-1', { '1': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ priorVerifiers: ['bob'] })))).toBe(-1);
    expect(verify(state, makeOp('verify_contribution', 'carol', verifyOp({ priorVerifiers: ['bob'] })))).toBe(0);
  });

  it('accuracy total increments on every completed check; upheld increments at settle', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state, 'c-acc'); // submitted+verified+settled helper from the phase-2 suite (2-verifier flow under v2)
    ... asserts: state.getRegister(CHECK_NAMES.total('bob')) === 1, upheld via settle's verifiers list
  });
});
```

(Final accuracy test depends on Task 3's settle change — write its assertions AFTER Task 3 lands, or write the two-verifier C_1 helper now (bob+carol both verify) and the settle-side asserts with `verifiers: ['bob','carol']` in the settle payload — since Task 3 changes the settle payload, put the accuracy-upheld test in Task 3 instead. Pin only the TOTAL increment here.)

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — in `makeVerifyContributionHandler` (imports merge RECIP_NAMES/CHECK_NAMES):

After the no-self check and the member/exists checks (BEFORE the credit/bump/records — all-or-nothing validation first):

```typescript
    const priorVerifiers = Array.isArray(payload.priorVerifiers)
      ? payload.priorVerifiers.filter((v) => typeof v === 'string')
      : [];
    if (priorVerifiers.includes(op.signerId)) {
      return -1; // all-parties: distinct verifiers (client-attested list)
    }
    if (state.setContains(RECIP_NAMES.verifiedBy(payload.submitter), op.signerId)) {
      return -1; // per-pair once: this verifier already verified this submitter
    }
    if (state.setContains(RECIP_NAMES.verifiedBy(op.signerId), payload.submitter)) {
      return -1; // mutual loop bar: the submitter previously verified this verifier
    }
```

On SUCCESS (after the per-check credit + before/alongside the counter bump — position it right where the per-check fee is applied, i.e., after all validation and before any record writes):

```typescript
    try { node.addRegister(CHECK_NAMES.total(op.signerId), 0); } catch (err) { /* exists */ }
    const totalChecks = (state.getRegister(CHECK_NAMES.total(op.signerId)) || 0) + 1;
    state.setRegister(CHECK_NAMES.total(op.signerId), totalChecks, op.signerId);
    try { node.addORSet(RECIP_NAMES.verifiedBy(payload.submitter)); } catch (err) { /* exists */ }
    state.setAdd(RECIP_NAMES.verifiedBy(payload.submitter), op.signerId, payload.contributionId);
```

Careful — the ORSet element `op.signerId` with tag `payload.contributionId` (dedupe-safe; per-pair once is enforced by the setContains check before add, so duplicate tags can't occur on the same pair).

Note the ORDER: the reciprocity checks MUST come before the per-check credit (a barred verifier gets paid no fee).

- [ ] **Step 5: Run** both suites PASS; full PASS. Commit:

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: reciprocity guard and per-verifier accuracy total in verify_contribution"
```

---

### Task 3: `appeal_verdict` op

**Files:**
- Modify: `shared/src/types.ts` (AppealVerdictPayload)
- Modify: `shared/src/policies.ts` (appeal_verdict policy)
- Modify: `shared/src/handlers.ts` (makeAppealVerdictHandler)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Types** — add to `shared/src/types.ts`:

```typescript
export interface AppealVerdictPayload {
  contributionId: string;
  submitter: string; // must equal op.signerId (submitter-only)
  reason: string;
}
```

Policy (policies.ts — widened form like the spine's member ops):

```typescript
  appeal_verdict: 'role:member OR role:custodian',
```

CONTRIB_NAMES addition (policies.ts):

```typescript
  // Set once per contribution by appeal_verdict (no chained appeals in phase 3).
  appealed: (contributionId: string) => `contrib:${contributionId}:appealed`,
```

- [ ] **Step 2: Tests first (red)** — append to `server/test/contribution.test.ts`:

```typescript
import { makeAppealVerdictHandler } from '../../shared/src/handlers';
import { AppealVerdictPayload, STATUS_REJECTED } from '../../shared/src/types'; // re-export status consts via contribution.ts

function rejectedAndAppealable(node: MockNode, state: MockState, id: string) {
  setupSubmitted(state, node, 'alice', id, { '2': 1 });
  const verify = makeVerifyContributionHandler(node);
  expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: id, pass: false, reason: 'insufficient' })))).toBe(0);
  expect(state.getRegister(CONTRIB_NAMES.status(id))).toBe(2);
}

describe('appeal_verdict', () => {
  it('the submitter appeals a rejected contribution: status 3, verify step rewindable, once', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app1');
    const appeal = makeAppealVerdictHandler(node, { getTimeMs: () => 5000 });
    expect(appeal(state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app1', submitter: 'alice', reason: 'evidence was misread' } as AppealVerdictPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app1'))).toBe(3);
    expect(state.getRegister(CONTRIB_NAMES.appealed('c-app1'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.step('c-app1'))).toBe(1); // rewound to the verify step
    const records = state.allSetElements(CONTRIB_NAMES.explanations('c-app1'));
    const appealRecord = JSON.parse(records.find((e) => e.includes('"appeal"'))!);
    expect(appealRecord.stepId).toBe('appeal');
    expect(appealRecord.reason).toBe('evidence was misread');
    expect(appealRecord.at).toBe(5000);
  });

  it('rejects non-submitter appeals, double appeals, and appeals of accepted/pending/unknown', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app2');
    const appeal = makeAppealVerdictHandler(node);
    expect(appeal(state, makeOp('appeal_verdict', 'bob',
      { contributionId: 'c-app2', submitter: 'alice', reason: 'not mine' } as AppealVerdictPayload))).toBe(-1);
    setupSubmitted(state, node, 'carol2', 'c-app3', { '2': 1 }); // pending, never verified
    expect(appeal(state, makeOp('appeal_verdict', 'carol2',
      { contributionId: 'c-app3', submitter: 'carol2', reason: 'pending' } as AppealVerdictPayload))).toBe(-1);
    expect(appeal(state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app2', submitter: 'alice', reason: 'first appeal' } as AppealVerdictPayload))).toBe(0);
    expect(appeal(state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app2', submitter: 'alice', reason: 'again' } as AppealVerdictPayload))).toBe(-1);
  });

  it('an appealed contribution re-verifies under the SAME schema rules; acceptance completes normally', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app4');
    const appeal = makeAppealVerdictHandler(node);
    const verify = makeVerifyContributionHandler(node);
    expect(appeal(state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app4', submitter: 'alice', reason: 'appealing' } as AppealVerdictPayload))).toBe(0);
    setupMembers(state, 'carol');
    expect(verify(state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-app4', reason: 're-review ok' })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app4'))).toBe(1); // accepted on re-review
    // settle completes it
    const settle = makeSettleContributionHandler(node);
    expect(settle(state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-app4', submitter: 'alice', reason: 'settled after appeal' } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app4'))).toBe(1);
  });
});
```

(Careful: 'c-app4' uses dims {'2': 1} → single-verify schema → carol's single verify completes the verify step and advances to settle ✓. bob's reciprocity: bob verified alice once in the reject — carol (fresh member) verifying again is legal (bob is per-pair-blocked). Note 'carol2' name to avoid colliding with 'carol' member usage elsewhere in the file — adapt to the file's names.)

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — add to `shared/src/handlers.ts`:

```typescript
export function makeAppealVerdictHandler(
  node: { addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: AppealVerdictPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.submitter) ||
      !isNonEmptyString(payload.reason)
    ) {
      return -1;
    }
    if (payload.submitter !== op.signerId) {
      return -1; // appeals are the submitter's only
    }
    if (!state.setContains(STATE_NAMES.contributions, payload.contributionId)) {
      return -1;
    }
    const statusReg = CONTRIB_NAMES.status(payload.contributionId);
    const appealedReg = CONTRIB_NAMES.appealed(payload.contributionId);
    if (state.getRegister(statusReg) !== STATUS_REJECTED) {
      return -1; // only rejected contributions are appealable (status values: see contribution.ts)
    }
    if (state.getRegister(appealedReg) === 1) {
      return -1; // once per contribution
    }

    try { node.addRegister(appealedReg, 0); } catch (err) { /* exists */ }
    state.setRegister(appealedReg, 1, op.signerId);
    state.setRegister(statusReg, STATUS_APPEALED, op.signerId);
    state.setRegister(CONTRIB_NAMES.step(payload.contributionId), 1, op.signerId); // rewind to the verify step (positional; every current schema has verify at index 1)
    // The verify handler's status gate accepts STATUS_PENDING or STATUS_APPEALED (Task 2's sibling change).

    try { node.addORSet(CONTRIB_NAMES.explanations(payload.contributionId)); } catch (err) { /* exists */ }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const explanation = {
      contributionId: payload.contributionId,
      stepId: 'appeal',
      reason: payload.reason,
      at: nowMs,
    };
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(explanation), `appeal:${op.signerId}`);
    return 0;
  };
}
```

AND the verify handler's status gate in the same commit (its `status === 0` check becomes):

```typescript
    if (status !== STATUS_PENDING && status !== STATUS_APPEALED) {
      return -1;
    }
```

(imports merge STATUS_PENDING/STATUS_APPEALED/STATUS_REJECTED from './contribution'; also the settle handler's status-0 gate — settle requires an ACCEPTED-after-verify contribution: check what settle's guard is — it currently requires step register === 2; after an appeal the step register is 1 and verification re-advances it to 2 — no settle change needed unless its status gate says `!== 0`: it must accept status 3 too (an appealed contribution that re-verified: status is STILL 3 until settle... check the current settle path: verify's final-acceptance sets status 1 at the TERMINAL verify step OR advances — for 3-step schemas verify advances (status stays whatever it was — 0 or 3 after appeal). Settle sets status 1. Settle's current gate `status !== 0 → -1` must become `status === STATUS_PENDING || status === STATUS_APPEALED`. Handle BOTH gates in this task.)

- [ ] **Step 5: Run** full `npm test` PASS (8 suites, expect ~118). Commit:

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: appeal_verdict re-opens rejected contributions once (status 3)"
```

---

### Task 4: Settle-side upheld accuracy (verifiers list)

**Files:**
- Modify: `shared/src/types.ts` (SettleContributionPayload gains `verifiers?: string[]`)
- Modify: `shared/src/handlers.ts` (settle handler increments upheld)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Tests first (red) — append:**

```typescript
describe('settle upheld-accuracy increments', () => {
  it('the submitter’s settle lists verifiers; each upheld register increments once', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-up1', { '2': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({})))).toBe(0);
    const settle = makeSettleContributionHandler(node);
    expect(settle(state, makeOp('settle_contribution', 'alice', {
      contributionId: 'c-up1', submitter: 'alice', reason: 'done', verifiers: ['bob'],
    } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CHECK_NAMES.upheld('bob'))).toBe(1);
    expect(state.getRegister(CHECK_NAMES.total('bob'))).toBe(1);
    expect(state.getRegister(CHECK_NAMES.upheld('ghost'))).toBeUndefined(); // non-listed verifier untouched
  });

  it('settle accepts verifiers as known members only; unlisted or non-member verifiers rejected', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-up2', { '2': 1 });
    const verify = makeVerifyContributionHandler(node);
    verify(state, makeOp('verify_contribution', 'bob', verifyOp({})));
    const settle = makeSettleContributionHandler(node);
    expect(settle(state, makeOp('settle_contribution', 'alice', {
      contributionId: 'c-up2', submitter: 'alice', reason: 'x', verifiers: ['not-a-member'],
    } as SettleContributionPayload))).toBe(-1);
    // unlisted-but-known verifiers: allowed (PoC: client-attested list, empty = nothing tracked)
    expect(settle(state, makeOp('settle_contribution', 'alice', {
      contributionId: 'c-up2', submitter: 'alice', reason: 'x', verifiers: [],
    } as SettleContributionPayload))).toBe(0);
  });
});
```

- [ ] **Step 2: Run** → FAIL (settle doesn't know `verifiers`).

- [ ] **Step 3: Implement** — in `makeSettleContributionHandler`, after the payload validations:

```typescript
    const verifiers = Array.isArray(payload.verifiers)
      ? [...new Set(payload.verifiers.filter((v) => typeof v === 'string' && isNonEmptyString(v)))]
      : [];
    for (const verifier of verifiers) {
      if (!state.setContains(STATE_NAMES.members, verifier)) {
        return -1;
      }
    }
```

and before the status write (only when settlement actually proceeds):

```typescript
    for (const verifier of verifiers) {
      try { node.addRegister(CHECK_NAMES.upheld(verifier), 0); } catch (err) { /* exists */ }
      const upheld = (state.getRegister(CHECK_NAMES.upheld(verifier)) || 0) + 1;
      state.setRegister(CHECK_NAMES.upheld(verifier), upheld, op.signerId);
    }
```

(The upheld increment fires on ACCEPTED settle — this handler runs only on accepted-settleable contributions by construction; note in a comment that this counts acceptance-at-settle, the phase-3 accuracy proxy.)

- [ ] **Step 4: Run** full PASS; Commit:

```bash
git add shared/src/types.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: settle-side upheld accuracy increments from client-attested verifier list"
```

---

### Task 5: Server wiring — appeal op + real-wasm v2 lifecycle tests

**Files:**
- Modify: `server/src/crabs.ts`
- Test: `server/test/crabs.test.ts`

- [ ] **Step 1: Real-wasm test first (red)** — append to `server/test/crabs.test.ts`:

```typescript
it('v2 two-verifier lifecycle through the real wasm node', async () => {
  const dao = new DaoNode();
  await dao.init();
  // members: alice, bob, carol (real key pairs, registerMember)
  // alice submits 'r-v2-1' dims {'1': 1} schemaVersion 'v2'
  // bob verifies accepted (priorVerifiers: [])
  // bob verifies AGAIN (same contributionId) → expect rejection (priorVerifiers ['bob'] attested by client; also reciprocity per-pair)
  // carol verifies accepted (priorVerifiers: ['bob'])
  // lifecycle advanced to settle; alice settles (verifiers: ['bob','carol'])
  // asserts: step=2, status accepted, rct NOT yet published (no aggregation), bob accuracy total=1… wait bob's verify + repeat attempt: only ONE completed check → total 1; carol total 1; upheld bob=1, carol=1 at settle.
  expect(dao.getCurrentRound()).toBe(1);
  expect(dao.getResBalance('alice')).toBe(12);      // C_1 bounty fired once at final acceptance
  expect(dao.getResBalance('bob')).toBe(2);         // per-check credit, one completed check
  expect(dao.getResBalance('carol')).toBe(2);
});
```

```typescript
it('appeal through the real wasm node: rejected → appealed → re-verified → accepted', async () => {
  // alice submits (v2, dims {'2': 1}), bob verifies REJECTED (status 2)
  // alice appeals (appeal_verdict) → status 3
  // carol re-verifies accepted → status advances; alice settles (verifiers ['carol'])
  // asserts include status transitions per register value.
});
```

NOTE: expected RES values — C_2 bounty 3; per-check 2 each; derive from RES_CONFIG, write actual constants in asserts with the arithmetic comment (use `RES_CONFIG.buildingBounty` etc. to avoid brittleness).

- [ ] **Step 2: Run** → FAIL (appeal policy/handler missing).

- [ ] **Step 3: Implement** — in `server/src/crabs.ts`:

```typescript
    this.node.setPolicy('appeal_verdict', POLICIES.appeal_verdict);
    this.node.registerHandlerJs('appeal_verdict', makeAppealVerdictHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
```

(+ imports.)

- [ ] **Step 4: Run** full suite PASS (8 suites, expect ~121). Commit:

```bash
git add server/src/crabs.ts server/test/crabs.test.ts
git commit -m "feat(server): appeal op wiring and v2 two-verifier wasm tests"
```

---

### Task 6: Client wiring — appeal sign method + accuracy getters

**Files:**
- Modify: `client/src/dao.ts`
- Verify: tsc baseline + vite build + jest green

- [ ] **Step 1: BrowserDao parity:**

```typescript
    this.node.setPolicy('appeal_verdict', POLICIES.appeal_verdict);
    this.node.registerHandlerJs('appeal_verdict', makeAppealVerdictHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
```

(+ imports + sign method:)

```typescript
  async appealVerdict(userId: string, payload: AppealVerdictPayload): Promise<Uint8Array> {
    return this.signAndSerialize('appeal_verdict', userId, JSON.stringify(payload));
  }
```

Getters (UI accuracy surface):

```typescript
  getVerifierStats(username: string): { total: number; upheld: number } {
    return {
      total: this.node.getRegister(CHECK_NAMES.total(username)) || 0,
      upheld: this.node.getRegister(CHECK_NAMES.upheld(username)) || 0,
    };
  }

  getContributionAppealed(contributionId: string): boolean {
    return (this.node.getRegister(CONTRIB_NAMES.appealed(contributionId)) || 0) === 1;
  }
```

Mirror: `mirrorContributionState` additionally handles `appeal_verdict` (records the appeal on the entry):

```typescript
    if (op.type !== 'submit_contribution' && op.type !== 'verify_contribution' && op.type !== 'settle_contribution' && op.type !== 'appeal_verdict') {
      return;
    }
```

and:

```typescript
    if (op.type === 'appeal_verdict') {
      const entry = this.contributions.get(payload.contributionId);
      if (entry) entry.appealedBy = op.signerId;
      return;
    }
```

(+ `appealedBy?: string` on `ContributionMirrorEntry`.)

- [ ] **Step 2: Gates + commit**

```bash
git add client/src/dao.ts
git commit -m "feat(client): appeal op wiring, verifier stats, and appeal mirror"
```

---

### Task 7: UI — appeal button, two-verifier progress, accuracy badges

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/ui.ts`
- Modify: `client/src/theme.css` (minor)
- Verify: `npm run build:client` + manual two/three-browser flow

- [ ] **Step 1: Verify-fleet flows (ui.ts):**
  - `onVerifyContribution` (existing) now supplies `priorVerifiers` from the mirror: when the contribution entry already carries `verifiedBy`, pass `priorVerifiers: [entry.verifiedBy]`; refuse to submit when `entry.verifiedBy === wallet.username` (client-enforced distinct-actor + original-verifier exclusion — the SAME exclusion covers appeals per the spec).
  - NEW `onAppealContribution(entry)`: submitter-only, requires a written reason (prompt pattern like settle), submits `appealVerdict`, success → 'Appeal recorded — awaiting re-verification.' + `renderContributions()`.
  - Card rendering (buildContributionCard): rejected cards show an "Appeal…" button when `entry.submitter === wallet.username && !getContributionAppealed(id)` (wire the check to the register getter, not the mirror, for the once-guard); status pill for status 3 → 'appealed' (via wizardModel's appealed flag); the verify progress shows `(d/n)` already; the verify prompt shows the verifier's accuracy (`getVerifierStats(wallet.username)`) as a read-only stat line: 'Your checks: X (Y upheld)'.
- [ ] **Step 2: Gates:** `npm run build:client` pass; tsc delta 0 vs baseline; jest green (untouched).
- [ ] **Step 3: Manual verification (dev server, WAVEDB_PATH=/tmp/dao-p3-ui, fresh DB):**
  1. alice submits C_1 contribution; bob verifies (accept, reason) → progress (1/2); carol (or a third window) verifies → (2/2) → step advances; alice settles → accepted; balances: alice +12, bob +2, carol +2.
  2. bob tries verifying a SECOND alice contribution → UI refuses/refuses server-side (reciprocity) — either visible or error shown; document which.
  3. alice submits a C_2 record; bob verifies REJECTED → card rejected; alice clicks Appeal… → status 'appealed'; carol re-verifies accepted → alice settles → accepted; `check:bob:total` = 2 (both checks), upheld 0 for the rejected one.
  4. Accuracy stat line appears on the verifier prompt.
- [ ] **Step 4: Commit**

```bash
git add client/index.html client/src/ui.ts client/src/theme.css
git commit -m "feat(ui): appeal flow, two-verifier progress, and verifier accuracy"
```

---

### Task 8: e2e, hydration, docs

**Files:**
- Modify: `server/test/hydration.test.ts` (reciprocity/accuracy/appealed registers survive replay)
- Modify: `test-voting-browser.js` (three-page flow: two verifiers + appeal; round+aggregation unaffected)
- Modify: `docs/contribution-economy/README.md` (binding section paragraph)

- [ ] **Step 1: Hydration test (red first)** — full v2 lifecycle (alice/bob/carol + custodian calibration) + appeal path via signed ops; fresh DaoNode + hydrateDao; assert current: `second.getContributionStatus(...)`, accuracy registers (`dao.getVerifierStats`-equivalents via node reads — DaoNode may need the two getters: add `getVerifierStats`/`getContributionAppealed` matching the client's), and the reciprocity set survives (`node.setContains('recip:alice','bob')`). Add the two DaoNode getters if missing in the same commit.

- [ ] **Step 2: e2e extension** — `test-voting-browser.js`: extend the wizard section to the THREE-page flow (if the script launches two pages, spawn a third): alice submits C_1 → bob verifies (1/2) → carol verifies (2/2) → alice settles; a second C_2 submission by alice rejected by bob; alice appeals; carol re-verifies; settle; assert appeal + accuracy surfaces exist (query the DOM the way the script already does); assert round/aggregation still passes (spine + complete_round with the accepted entries list — carol's re-verify doesn't disturb the aggregation since complete_round only lists accepted contributions). Fresh DB requirement unchanged (header).

- [ ] **Step 3: Run both** — `npm test` (8 suites, expect ~123) and the e2e per its header instructions: report the result honestly.

- [ ] **Step 4: Docs** — extend `docs/contribution-economy/README.md`'s binding section with:

```markdown
- Phase 3 (2026-10-07): multi-verifier lifecycle — schema v2 declares C_1's
  verify as `all-parties, count 2` (legacy v1 contributions keep single
  verify via `schemaForRecord`), both-pass-or-dead; `appeal_verdict`
  re-opens rejected contributions once (status 3; original-verifier exclusion
  is client-enforced — CRABS cannot express identity exclusion handler-side);
  reciprocity guard (per-pair verify-once + mutual loop bar via `recip:` sets);
  verifier accuracy registers (`check:{u}:total`/`upheld`, fed by settle's
  client-attested verifier list); wizard surface shows progress (d/n), appeal
  button, and accuracy stats. Deferred: Tier 1 random audits, rotating appeal
  panel, accuracy-vs-chance capture detection, harm adjustments, retrieval
  economy.
```

- [ ] **Step 5: Commit**

```bash
git add server/test/hydration.test.ts server/src/crabs.ts test-voting-browser.js docs/contribution-economy/README.md
git commit -m "test/docs: phase-3 hydration + e2e coverage and binding docs"
```

---

## Self-review

- **Spec coverage:** schema-declared two-verifier C_1 + legacy (Task 1), reciprocity per-pair-once + mutual bar (Task 2), appeals once/status 3 + verify/settle status-3 gates (Task 3), accuracy total + upheld via settle verifiers (Tasks 2/4), wasm wiring + v2 lifecycle (Task 5), client parity + stats + mirror (Task 6), UI (Task 7), tests-e2e-docs (Task 8). Original-verifier exclusion = client-enforced (Tasks 6/7) with the documented limitation. Deferred (Tier 1/rotation/harm/retrieval/RCT-vote-token) untouched — matching the spec's Phase-boundaries section.
- **Placeholder scan:** the Task 2 accuracy-upheld test is deliberately placed in Task 4 (documented inline — not a placeholder, an ordering constraint); no TBDs.
- **Type consistency:** STATUS_* constants (Task 1) consumed in Tasks 3/5. `RECIP_NAMES.verifiedBy`/`CHECK_NAMES.total`/`upheld` (Task 2) consumed in Tasks 2/4/6/8. `priorVerifiers` (Task 2) supplied by UI (Task 7). `AppealVerdictPayload`/`appealed` register (Task 3) consumed in Tasks 5/6/7. `schemaForRecord` + known-version set (Task 1) consumed by handlers AND wizardModel (Task 1 covers both) AND the UI (Task 7 via getter).
- **Risk:** Task 3's status-gate change touches BOTH the verify handler's `0`-gate and the settle handler's gate — both must accept status 3; the plan instructs handling both in Task 3 (grep both handlers before editing).