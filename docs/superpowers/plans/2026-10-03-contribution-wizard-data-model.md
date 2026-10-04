# Contribution Wizard & Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the contribution wizard per `docs/superpowers/specs/2026-10-03-contribution-wizard-data-design.md` — generic per-dimension step schemas (static shared code), schema-driven contribution handlers, a pure-function wizard model for role-based views, and a server-side content-addressed store for bulky evidence.

**Architecture:** CRABS remains a fact ledger: contributions hold only small fact records, step counters, status, and explanation records. Step schemas are static TypeScript in `shared/src/contribution.ts` consulted by handlers and a new pure `shared/src/wizard.ts`; the wizard UI is a projection (`wizardModel`) of replicated facts, differing per role only in which actions are offered. Bulky evidence is uploaded to a content-addressed WaveDB store (`put_content`/`get_content` by sha-256) and referenced by hash inside CRABS.

**Tech Stack:** TypeScript, crabs-wasm (CRABS), WaveDB, Vite/esbuild client, Jest, Playwright e2e.

---

## Execution order (spans two plans)

This plan continues the phase-1 plan at `docs/superpowers/plans/2026-09-30-replace-timed-allocation-contribution-workflow.md` (issues #1–#9). Phase-1 is **not yet implemented**; this plan was authored after it and supersedes parts of it. Execute in this order:

| Order | What | Why |
| --- | --- | --- |
| 1 | Phase-1 issue **#1** (registry module) | creates `shared/src/contribution.ts`, `RES_*`, payload types |
| 2 | Phase-1 issues **#4, #5, #6, #8** | voting switch + timed-accrual deletion, server wiring, client mirror, hydration |
| 3 | **Superseded:** phase-1 issues **#2, #3** (plain submit/verify handlers) and **#7** (basic contribution UI) | This plan's Tasks 2-4, 8, 9 replace them with schema-driven versions and the wizard UI. Comment on those issues pointing here before closing them. |
| 4 | This plan's Tasks 1-10, in order | wizard + schemas + content store |

Tasks below assume the phase-1 code exists (issues #1, #4-#8 executed): `shared/src/contribution.ts` has `DIMENSIONS`, `isValidDims`, `paymentFor`, `RES_CONFIG`; `shared/src/handlers.ts` has un-schema'd `makeSubmitContributionHandler` / `makeVerifyContributionHandler`; `shared/src/policies.ts` has `RES_NAMES`, `CONTRIB_NAMES` (with `status` and `explanations`), `STATE_NAMES.contributions`, `POLICIES.submit_contribution`/`verify_contribution`; `server/test/contribution.test.ts` has MockNode/MockState/makeOp helpers and the phase-1 handler tests. When a task here says "replace" a phase-1 test, delete the old test body and write the shown one.

**Known PoC limitations carried forward** (unchanged from both prior docs): dims/submitter are payload-attested (handler state cannot enumerate ORSet elements); payments recompute deterministically from payloads on every replica; reviewer-capture hardening is a later phase.

---

### Task 1: Step schemas and evidence references in the registry

**Files:**
- Modify: `shared/src/contribution.ts` (add schema types, registry, `schemaForDims`, `validateEvidenceRef`, `stepPaymentsFor`, `SCHEMA_VERSION`, `CONTENT_LIMITS`)
- Test: `server/test/contribution.test.ts` (append a schema description block)

**Design recap (from the spec):** A `DimensionSchema` is an ordered list of `StepDef`s. Phase-1 wired schemas: C_1, C_2, C_18 are 3-step (`submit → verify → settle`); the default for the other 19 dimensions is 2-step (`submit → verify`). Verify steps carry both payment hooks: submitter `per-dims` + actor `per-check`. All-parties/majority modes are expressible but only `single` is wired.

- [ ] **Step 1: Write the failing test**

Append to `server/test/contribution.test.ts`:

```typescript
import {
  CONTENT_LIMITS, SCHEMA_VERSION, SCHEMAS, DEFAULT_SCHEMA,
  schemaForDims, validateEvidenceRef, stepPaymentsFor,
} from '../../shared/src/contribution';

describe('step schemas', () => {
  it('version is v1 and content limits are set', () => {
    expect(SCHEMA_VERSION).toBe('v1');
    expect(CONTENT_LIMITS.maxObjectBytes).toBe(8 * 1024 * 1024);
    expect(CONTENT_LIMITS.maxInlineEvidenceChars).toBe(2000);
  });

  it('wires C_1, C_2, C_18 as 3-step submit->verify->settle schemas', () => {
    for (const dim of [1, 2, 18]) {
      const schema = SCHEMAS.get(dim)!;
      expect(schema.dimIndex).toBe(dim);
      expect(schema.schemaVersion).toBe('v1');
      expect(schema.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']);
      expect(schema.steps[0].op).toBe('submit_contribution');
      expect(schema.steps[1].op).toBe('verify_contribution');
      expect(schema.steps[2].op).toBe('settle_contribution');
      expect(schema.steps[1].actors).toContain('verifier');
      expect(schema.steps[1].antiGaming).toContain('no-self');
      expect(schema.steps[1].antiGaming).toContain('written-reason');
    }
  });

  it('defines a 2-step default schema for unwired dimensions', () => {
    expect(DEFAULT_SCHEMA.steps.map((s) => s.stepId)).toEqual(['submit', 'verify']);
    expect(schemaForDims({ '9': 1 }).dimIndex).toBe(-1);
    expect(schemaForDims({ '9': 1 })).toBe(DEFAULT_SCHEMA);
  });

  it('resolves the schema of the lowest wired dimIndex (deterministic priority)', () => {
    expect(schemaForDims({ '1': 0.5, '2': 1 }).dimIndex).toBe(1);
    expect(schemaForDims({ '18': 1, '2': 1 }).dimIndex).toBe(2);
    expect(schemaForDims({ '18': 1 }).dimIndex).toBe(18);
  });

  it('verify steps pay the actor per check and the submitter per dims', () => {
    const step = SCHEMAS.get(1)!.steps[1];
    const pays = stepPaymentsFor(step, { '1': 1, '2': 0.5 },
      { actor: 'bob', submitter: 'alice' });
    expect(pays.get('bob')).toBe(RES_CONFIG.verificationCheckCredit);
    expect(pays.get('alice')).toBe(RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5);
  });

  describe('validateEvidenceRef', () => {
    const good = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };
    it('accepts well-formed refs', () => expect(validateEvidenceRef(good)).toBe(true));
    it('rejects malformed refs', () => {
      expect(validateEvidenceRef({ ...good, hash: 'zz' })).toBe(false);
      expect(validateEvidenceRef({ ...good, uri: '' })).toBe(false);
      expect(validateEvidenceRef({ ...good, mediaType: '' })).toBe(false);
      expect(validateEvidenceRef({ ...good, size: -1 })).toBe(false);
      expect(validateEvidenceRef({ ...good, hash: 'zz'.repeat(32) })).toBe(false);
      expect(validateEvidenceRef(null)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contribution.test.ts`
Expected: FAIL — schema exports missing.

- [ ] **Step 3: Write minimal implementation**

Add to `shared/src/contribution.ts`:

```typescript
// --- Evidence references (content lives out-of-band; CRABS holds pointers) ---

export interface EvidenceRef {
  hash: string; // sha-256 hex of the content OR of the pointer text
  uri: string;  // 'content://{hash}' for stored objects, otherwise a pointer (URL, id, …)
  mediaType: string;
  size: number; // bytes (0 allowed for pure pointers)
}

export const CONTENT_LIMITS = {
  maxObjectBytes: 8 * 1024 * 1024,
  maxInlineEvidenceChars: 2000,
} as const;

const HASH_RE = /^[0-9a-f]{64}$/;

export function validateEvidenceRef(ref: unknown): ref is EvidenceRef {
  if (!ref || typeof ref !== 'object') return false;
  const r = ref as Partial<EvidenceRef>;
  return (
    typeof r.hash === 'string' && HASH_RE.test(r.hash) &&
    typeof r.uri === 'string' && r.uri !== '' && r.uri.length <= CONTENT_LIMITS.maxInlineEvidenceChars &&
    typeof r.mediaType === 'string' && r.mediaType !== '' && r.mediaType.length <= 64 &&
    typeof r.size === 'number' && Number.isInteger(r.size) && r.size >= 0
  );
}

// --- Step schemas (static code on every replica — handlers consult these) ---

export type StepActor = 'submitter' | 'verifier' | 'custodian' | 'member';
export type PayRule = 'per-dims' | 'per-check' | 'flat';
export type RequirementMode = 'single' | 'all-parties' | 'majority';

export interface StepDef {
  stepId: string;
  title: string;
  requirement: { mode: RequirementMode; count: number };
  actors: StepActor[];
  op: 'submit_contribution' | 'verify_contribution' | 'settle_contribution';
  pays?: Array<{ who: 'submitter' | 'actor'; rule: PayRule; amount?: number }>;
  antiGaming?: Array<'no-self' | 'written-reason' | 'both-parties'>;
}

export interface DimensionSchema {
  dimIndex: number;      // -1 = default schema for unwired dimensions
  schemaVersion: string;
  steps: StepDef[];
}

export const SCHEMA_VERSION = 'v1' as const;

const VERIFY_STEP: StepDef = {
  stepId: 'verify',
  title: 'Verification',
  requirement: { mode: 'single', count: 1 },
  actors: ['verifier'],
  op: 'verify_contribution',
  pays: [
    { who: 'actor', rule: 'per-check' },          // C_18 Moon: per completed check, either direction
    { who: 'submitter', rule: 'per-dims' },       // class-specific outcome bounties on acceptance
  ],
  antiGaming: ['no-self', 'written-reason'],
};

const SUBMIT_STEP: StepDef = {
  stepId: 'submit',
  title: 'Submission',
  requirement: { mode: 'single', count: 1 },
  actors: ['submitter'],
  op: 'submit_contribution',
};

const SETTLE_STEP: StepDef = {
  stepId: 'settle',
  title: 'Settlement',
  requirement: { mode: 'single', count: 1 },
  actors: ['submitter'],
  op: 'settle_contribution',
  antiGaming: ['written-reason'],
};

export const DEFAULT_SCHEMA: DimensionSchema = {
  dimIndex: -1,
  schemaVersion: SCHEMA_VERSION,
  steps: [SUBMIT_STEP, VERIFY_STEP],
};

export const SCHEMAS: Map<number, DimensionSchema> = new Map();
for (const dimIndex of [1, 2, 18]) {
  SCHEMAS.set(dimIndex, { dimIndex, schemaVersion: SCHEMA_VERSION, steps: [SUBMIT_STEP, VERIFY_STEP, SETTLE_STEP] });
}

export function schemaForDims(dims: Record<string, number>): DimensionSchema {
  const wired = Object.keys(dims)
    .map(Number)
    .filter((i) => SCHEMAS.has(i))
    .sort((a, b) => a - b);
  return wired.length > 0 ? SCHEMAS.get(wired[0])! : DEFAULT_SCHEMA;
}

// Payment helper: which side receives what when a verify step completes.
// - 'per-check' pays the actor on EVERY completion of the check.
// - 'per-dims'/'flat' pay at the step's final requirement completion.
export function stepPaymentsFor(
  step: StepDef,
  dims: Record<string, number>,
  parties: { actor: string; submitter: string }
): Map<string, number> {
  const out = new Map<string, number>();
  for (const pay of step.pays ?? []) {
    const target = whoTarget(pay.who, parties);
    let amount = 0;
    if (pay.rule === 'per-check') {
      amount = pay.amount ?? RES_CONFIG.verificationCheckCredit;
    } else if (pay.rule === 'per-dims') {
      for (const [dimKey, match] of Object.entries(dims)) {
        amount += paymentFor(Number(dimKey), match);
      }
    } else {
      amount = pay.amount ?? 0;
    }
    out.set(target, (out.get(target) ?? 0) + amount);
  }
  return out;
}

function whoTarget(who: 'submitter' | 'actor', parties: { actor: string; submitter: string }): string {
  return who === 'actor' ? parties.actor : parties.submitter;
}
```

Note: build `SCHEMAS` with a straightforward loop — the contract is just `SCHEMAS: Map<number, DimensionSchema>` with entries for 1, 2, 18 sharing the 3-step shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/contribution.ts server/test/contribution.test.ts
git commit -m "feat: dimension step schemas and evidence refs in contribution registry"
```

---

### Task 2: wizardModel — the pure projection function

**Files:**
- Create: `shared/src/wizard.ts`
- Test: `server/test/wizard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/wizard.test.ts` with the MockNode/MockState helpers **not** needed — this is a pure-function test:

```typescript
import { DEFAULT_SCHEMA, SCHEMAS, DimensionSchema, SCHEMA_VERSION } from '../../shared/src/contribution';
import { wizardModel, ContributionFacts } from '../../shared/src/wizard';

function c1Facts(stepIndex: number, done: Record<string, number>, status = 0): ContributionFacts {
  return { status, stepIndex, done, submitter: 'alice' };
}

describe('wizardModel', () => {
  const schema = SCHEMAS.get(1)!; // C_1: submit → verify → settle

  it('marks completed steps and the current step; later steps locked', () => {
    const m = wizardModel(schema, c1Facts(1, { submit: 1 }), 'alice');
    expect(m.currentStepIndex).toBe(1);
    expect(m.outcome).toBe('pending');
    expect(m.steps.map((s) => s.state)).toEqual(['complete', 'current', 'locked']);
  });

  it('offers the settle action only to the submitter at the settle step', () => {
    const m = wizardModel(schema, c1Facts(2, { submit: 1, verify: 1 }), 'alice');
    const settle = m.steps[2];
    expect(settle.state).toBe('current');
    expect(settle.roles.submitter?.mayAct).toBe(true);
    // A different viewer at the same step: submitter-only action is not offered.
    const m2 = wizardModel(schema, c1Facts(2, { submit: 1, verify: 1 }), 'bob');
    expect(m2.steps[2].roles.submitter?.mayAct).toBe(false);
  });

  it('offers verify to anyone except the submitter (C_18 no-self)', () => {
    const m = wizardModel(schema, c1Facts(1, { submit: 1 }), 'bob');
    expect(m.steps[1].roles.submitter?.mayAct).toBeFalsy();
    // bob is a potential verifier: verify action offered
    expect(m.steps[1].roles['verifier']?.mayAct).toBe(true);
    const mSelf = wizardModel(schema, c1Facts(1, { submit: 1 }), 'alice');
    expect(mSelf.steps[1].roles['verifier']?.mayAct).toBe(false);
  });

  it('reflects all-parties progress with partial completion still current', () => {
    const schemaAll: DimensionSchema = {
      dimIndex: 8, schemaVersion: SCHEMA_VERSION,
      steps: [DEFAULT_SCHEMA.steps[0],
        { ...SCHEMAS.get(1)!.steps[1], actors: ['verifier'], requirement: { mode: 'all-parties', count: 2 } }],
    };
    const half = wizardModel(schemaAll, c1Facts(1, { submit: 1, verify: 1 }), 'carol');
    expect(half.steps[1].state).toBe('current');
    expect(half.steps[1].progress).toEqual({ done: 1, required: 2 });
    const full = wizardModel(schemaAll, c1Facts(2, { submit: 1, verify: 2 }), 'carol');
    expect(full.steps[1].state).toBe('complete');
  });

  it('settled outcomes render all steps complete with the verdict', () => {
    const accepted = wizardModel(schema, c1Facts(3, { submit: 1, verify: 1, settle: 1 }, 1), 'alice');
    expect(accepted.outcome).toBe('accepted');
    expect(accepted.steps.every((s) => s.state === 'complete')).toBe(true);
    const rejected = wizardModel(DEFAULT_SCHEMA, c1Facts(1, { submit: 1, verify: 1 }, 2), 'alice');
    expect(rejected.outcome).toBe('rejected');
  });

  it('surfaces an unknown schema version as read-only', () => {
    const stale: DimensionSchema = { ...schema, schemaVersion: 'v0' };
    const m = wizardModel(stale, c1Facts(1, { submit: 1 }), 'alice');
    expect(m.readOnly).toBe(true);
    expect(m.outcome).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- wizard.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `shared/src/wizard.ts`:

```typescript
import { DimensionSchema, SCHEMA_VERSION, StepDef } from './contribution';

export interface ContributionFacts {
  status: number;               // 0 pending, 1 accepted, 2 rejected, -1 unknown
  stepIndex: number;            // current step position in schema.steps
  done: Record<string, number>; // stepId -> completed requirements
  submitter: string;
}

export type StepState = 'complete' | 'current' | 'locked';

export interface WizardStep {
  stepId: string;
  title: string;
  op: string;
  state: StepState;
  progress: { done: number; required: number };
  actors: string[];
  pays?: Array<{ who: 'submitter' | 'actor'; rule: string; amount?: number }>;
  roles: Partial<Record<'submitter' | 'verifier' | 'custodian' | 'member', { mayAct: boolean; op: string; label: string }>>;
}

export interface WizardModel {
  schemaVersion: string;
  readOnly: boolean;      // schema mismatch or unknown lifecycle → render read-only
  outcome: 'pending' | 'accepted' | 'rejected';
  currentStepIndex: number;
  steps: WizardStep[];
}

function actorAllowed(actor: string, facts: ContributionFacts, viewerId: string, viewerIsCustodian: boolean): boolean {
  switch (actor) {
    case 'submitter': return viewerId === facts.submitter;
    case 'verifier': return viewerId !== facts.submitter;
    case 'custodian': return viewerIsCustodian;
    default: return true; // 'member'
  }
}

function actorMayAct(
  step: StepDef, facts: ContributionFacts, viewerId: string, viewerIsCustodian: boolean
): boolean {
  return step.actors.some((a) => actorAllowed(a, facts, viewerId, viewerIsCustodian));
}

export function wizardModel(
  schema: DimensionSchema,
  facts: ContributionFacts,
  viewerId: string,
  viewerIsCustodian = false
): WizardModel {
  const readOnly = schema.schemaVersion !== SCHEMA_VERSION || facts.status === -1;
  if (readOnly) {
    return {
      schemaVersion: schema.schemaVersion,
      readOnly: true,
      outcome: 'pending',
      currentStepIndex: -1,
      steps: schema.steps.map((s) => stepView(s, facts, viewerId, viewerIsCustodian, 'locked', true)),
    };
  }

  if (facts.status !== 0) {
    // Settled: every requirement is final; surface the verdict.
    return {
      schemaVersion: schema.schemaVersion,
      readOnly: false,
      outcome: facts.status === 1 ? 'accepted' : 'rejected',
      currentStepIndex: -1,
      steps: schema.steps.map((s) => stepView(s, facts, viewerId, viewerIsCustodian, 'complete', false)),
    };
  }

  const seen: StepState[] = [];
  for (let i = 0; i < schema.steps.length; i++) {
    const done = facts.done[schema.steps[i].stepId] ?? 0;
    seen.push(done >= schema.steps[i].requirement.count ? 'complete' : 'current');
    if (seen[i] === 'current') {
      for (let j = i + 1; j < schema.steps.length; j++) seen.push('locked');
      break;
    }
  }
  const currentStepIndex = seen.indexOf('current');

  return {
    schemaVersion: schema.schemaVersion,
    readOnly: false,
    outcome: 'pending',
    currentStepIndex,
    steps: schema.steps.map((s, i) => stepView(s, facts, viewerId, viewerIsCustodian, seen[i], true)),
  };
}

function stepView(
  step: StepDef,
  facts: ContributionFacts,
  viewerId: string,
  viewerIsCustodian: boolean,
  state: StepState,
  actionable: boolean
): WizardStep {
  const roles: WizardStep['roles'] = {};
  if (actionable && state === 'current') {
    for (const actor of ['submitter', 'verifier', 'custodian', 'member'] as const) {
      if (!step.actors.includes(actor)) continue;
      roles[actor] = {
        mayAct: actorMayAct(step, facts, viewerId, viewerIsCustodian),
        op: step.op,
        label: step.title,
      };
    }
  }
  return {
    stepId: step.stepId,
    title: step.title,
    op: step.op,
    state,
    progress: { done: facts.done[step.stepId] ?? 0, required: step.requirement.count },
    actors: [...step.actors],
    pays: step.pays?.map((p) => ({ ...p })),
    roles,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- wizard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/wizard.ts server/test/wizard.test.ts
git commit -m "feat: pure wizardModel projection for role-based contribution views"
```

---

### Task 3: Schema-driven submit_contribution (evidence refs, lifecycle init)

**Files:**
- Modify: `shared/src/types.ts` (ContributionPayload gains `evidenceRef`, `schemaVersion`)
- Modify: `shared/src/handlers.ts` (replace phase-1 `makeSubmitContributionHandler`)
- Test: `server/test/contribution.test.ts` (replace the phase-1 submit tests)

- [ ] **Step 1: Update types**

In `shared/src/types.ts`, replace the phase-1 `ContributionPayload` with (and add `import { EvidenceRef } from './contribution'`):

```typescript
export interface ContributionPayload {
  contributionId: string;
  dims: Record<string, number>;
  summary: string;
  evidenceRef: EvidenceRef;    // pointer, never content
  schemaVersion: string;       // must equal SCHEMA_VERSION
}
```

- [ ] **Step 2: Update the tests (red)**

In `server/test/contribution.test.ts`, update the `submitOp` helper and the submit describe block — any `evidence: '…'` field becomes `evidenceRef`/`schemaVersion`:

```typescript
const GOOD_REF = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };

function submitOp(payload: Partial<ContributionPayload>, signer = 'alice'): ContributionPayload {
  return {
    contributionId: 'c-1',
    dims: { '2': 1 },
    summary: 'Wrote an architecture record',
    evidenceRef: GOOD_REF,
    schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as ContributionPayload;
}
```

Updated/added submit test cases (replace the phase-1 submit block; keep MockNode/MockState/makeOp/setupMembers as-is):

```typescript
describe('submit_contribution handler (schema-driven)', () => {
  it('records the contribution and initializes the lifecycle at the verify step', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({})))).toBe(0);
    expect(state.setContains(STATE_NAMES.contributions, 'c-1')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(0);
    // lifecycle position: submit auto-completed ⇒ current step = index 1
    expect(state.getRegister(CONTRIB_NAMES.step('c-1'))).toBe(1);
    // submit step's requirement counter is satisfied
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-1', 'submit'))).toBe(1);
  });

  it('rejects a non-member submitter', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSubmitContributionHandler(node);
    expect(handler(state, makeOp('submit_contribution', 'mallory', submitOp({})))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-1')).toBe(false);
  });

  it('rejects duplicate contributionId, invalid dims, bad schemaVersion, bad evidenceRef', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({})))).toBe(0);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ summary: 'again' })))).toBe(-1);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ dims: {} })))).toBe(-1);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ schemaVersion: 'v0' })))).toBe(-1);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ evidenceRef: { ...GOOD_REF, hash: 'zz' } })))).toBe(-1);
  });

  it('rejects missing summary', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    expect(handler(state, makeOp('submit_contribution', 'alice', submitOp({ summary: '' })))).toBe(-1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- contribution.test.ts`
Expected: FAIL — handler ignores `evidenceRef`/`schemaVersion`, never writes the step register or submit counter; `CONTRIB_NAMES.step`/`stepDone` do not exist.

- [ ] **Step 4: Implement**

Add to `CONTRIB_NAMES` in `shared/src/policies.ts`:

```typescript
  // Lifecycle position register: index into schema.steps (submit auto-complete ⇒ 1).
  step: (contributionId: string) => `contrib:${contributionId}:step`,
  // Per-step requirement-completion counter.
  stepDone: (contributionId: string, stepId: string) => `contrib:${contributionId}:d:${stepId}`,
```

Replace `makeSubmitContributionHandler` in `shared/src/handlers.ts` (imports gain `validateEvidenceRef` and `SCHEMA_VERSION` from `./contribution`):

```typescript
export function makeSubmitContributionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.summary) ||
      !isNonEmptyString(payload.schemaVersion) ||
      payload.schemaVersion !== SCHEMA_VERSION ||
      !isValidDims(payload.dims) ||
      !validateEvidenceRef(payload.evidenceRef) ||
      !state.setContains(STATE_NAMES.members, op.signerId) ||
      state.setContains(STATE_NAMES.contributions, payload.contributionId)
    ) {
      return -1;
    }

    const schema = schemaForDims(payload.dims);

    try { node.addORSet(CONTRIB_NAMES.explanations(payload.contributionId)); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(CONTRIB_NAMES.step(payload.contributionId), 1); } catch (err) { /* ignore duplicate */ }
    for (const step of schema.steps) {
      try { node.addPNCounter(CONTRIB_NAMES.stepDone(payload.contributionId, step.stepId)); } catch (err) { /* ignore duplicate */ }
    }
    state.setRegister(CONTRIB_NAMES.status(payload.contributionId), 0, op.signerId);
    state.incrementPNCounter(CONTRIB_NAMES.stepDone(payload.contributionId, 'submit'), 1, op.signerId);

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = {
      contributionId: payload.contributionId,
      submitter: op.signerId,
      dims: payload.dims,
      summary: payload.summary,
      evidenceRef: payload.evidenceRef,
      schemaVersion: payload.schemaVersion,
      submittedAt: nowMs,
    };
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(record), op.signerId);
    state.setAdd(STATE_NAMES.contributions, payload.contributionId, op.signerId);
    return 0;
  };
}
```

(The step register initial value `1` is correct only because every phase-1 schema begins with a submit step whose op is `submit_contribution`; if a future schema starts elsewhere, compute `initialStep` the same way `wizardModel` does — out of scope here per YAGNI.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS or RED only in the phase-1 verify tests (they don't send `stepId`) — those are replaced in Task 4.

- [ ] **Step 7: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: schema-driven submit_contribution with evidence refs and lifecycle init"
```

---

### Task 4: Schema-driven verify_contribution (step validation, counters, payments)

**Files:**
- Modify: `shared/src/types.ts` (VerifyContributionPayload gains `stepId`)
- Modify: `shared/src/handlers.ts` (replace phase-1 `makeVerifyContributionHandler`)
- Test: `server/test/contribution.test.ts` (replace the phase-1 verify tests)

Pay semantics implemented here: submitter outcome bounties (`per-dims`) fire only at the step's final requirement completion **and** `pass === true`; the actor's per-check credit fires on **every** verification completion regardless of direction. A rejection terminates the lifecycle immediately (status 2).

- [ ] **Step 1: Update types**

In `shared/src/types.ts`:

```typescript
export interface VerifyContributionPayload {
  contributionId: string;
  submitter: string;
  dims: Record<string, number>;   // re-presented for deterministic payment recomputation
  stepId: string;                 // must match the schema's current step
  pass: boolean;
  reason: string;
}
```

- [ ] **Step 2: Update the tests (red)**

Replace the phase-1 `verify_contribution` describe block in `server/test/contribution.test.ts` with (reusing `setupSubmitted` extended for the new submit helper):

```typescript
function setupSubmitted(state: MockState, node: MockNode, signer = 'alice', contributionId = 'c-1', dims: Record<string, number> = { '2': 1 }) {
  state.setAdd(STATE_NAMES.members, signer, signer);
  state.setAdd(STATE_NAMES.members, 'bob', 'bob');
  const handler = makeSubmitContributionHandler(node);
  handler(state, makeOp('submit_contribution', signer, submitOp({ contributionId, dims })));
  state.setRegister(`res:${signer}`, 0);
  state.setRegister('res:bob', 0);
}

function verifyOp(payload: Partial<VerifyContributionPayload>, signer = 'bob'): VerifyContributionPayload {
  return {
    contributionId: 'c-1', submitter: 'alice', dims: { '2': 1 }, stepId: 'verify',
    pass: true, reason: 'checks out',
    ...payload,
  } as VerifyContributionPayload;
}

describe('verify_contribution handler (schema-driven)', () => {
  it('pays the verifier per completed check regardless of direction, rejects on reject', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node);
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ pass: false, reason: 'no record link' })))).toBe(0);
    expect(state.getRegister('res:bob')).toBe(RES_CONFIG.verificationCheckCredit);
    expect(state.getRegister('res:alice')).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(2);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-1', 'verify'))).toBe(1);
  });

  it('on pass at the final requirement: pays submitter per-dims and advances to settle', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-multi', { '1': 1, '2': 0.5, '9': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-multi', dims: { '1': 1, '2': 0.5, '9': 1 }, reason: 'real artifact' })))).toBe(0);
    const expected = RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5;
    expect(state.getRegister('res:alice')).toBe(expected);
    expect(state.getRegister('dim:alice:c1')).toBe(1);
    expect(state.getRegister('dim:alice:c2')).toBe(0.5);
    expect(state.getRegister('dim:alice:c9')).toBeUndefined(); // classification-only dim: no tally
    expect(state.getRegister(CONTRIB_NAMES.step('c-multi'))).toBe(2); // advanced to settle
    expect(state.getRegister(CONTRIB_NAMES.status('c-multi'))).toBe(0); // lifecycle continues
    expect(state.getRegister('res:bob')).toBe(RES_CONFIG.verificationCheckCredit);
  });

  it('default schema: pass at the terminal verify step finalizes as accepted', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-term', { '9': 1 }); // C_9 unwired ⇒ default schema (verify is terminal)
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-term', dims: { '9': 1 } })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-term'))).toBe(1); // accepted, nothing left to do
    expect(state.getRegister('res:alice')).toBe(0);                    // no implemented dim ⇒ no bounty
    expect(state.getRegister('res:bob')).toBe(RES_CONFIG.verificationCheckCredit);
  });

  it('rejects verification of an own contribution', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-self');
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'alice',
      verifyOp({ contributionId: 'c-self', submitter: 'alice' })))).toBe(-1);
  });

  it('rejects a second verification (status already final at terminal step)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-twice', { '9': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-twice', dims: { '9': 1 } })))).toBe(0);
    const bobBalance = state.getRegister('res:bob');
    expect(verify(state, makeOp('verify_contribution', 'carol', verifyOp({ contributionId: 'c-twice', dims: { '9': 1 } })))).toBe(-1);
    // status is 1 (terminal) ⇒ second verify is rejected even though step counters moved on
    expect(verify(state, makeOp('verify_contribution', 'carol', verifyOp({ contributionId: 'c-twice', dims: { '9': 1 }, pass: false })))).toBe(-1);
    expect(state.getRegister('res:bob')).toBe(bobBalance);
  });

  it('rejects a wrong stepId or unknown contribution or unknown submitter', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-guards');
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ stepId: 'settle' })))).toBe(-1);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'ghost' })))).toBe(-1);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ submitter: 'ghost-user' })))).toBe(-1);
    expect(verify(state, makeOp('verify_contribution', 'bob', verifyOp({ dims: { '22': 1 } })))).toBe(-1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- contribution.test.ts`
Expected: FAIL — handler doesn't validate `stepId`, doesn't advance the step register, doesn't defer submitter payment/acceptance to the terminal step.

- [ ] **Step 4: Implement**

Replace `makeVerifyContributionHandler` in `shared/src/handlers.ts` (imports gain `schemaForDims`, `stepPaymentsFor`, `dimensionDeltaFor` from `./contribution`):

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
      !isNonEmptyString(payload.stepId) ||
      !isNonEmptyString(payload.reason) ||
      typeof payload.pass !== 'boolean' ||
      !isValidDims(payload.dims)
    ) {
      return -1;
    }
    if (payload.submitter === op.signerId) {
      return -1; // anti-gaming: no self-verification
    }
    if (!state.setContains(STATE_NAMES.members, payload.submitter)) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.contributions, payload.contributionId)) {
      return -1;
    }
    const statusReg = CONTRIB_NAMES.status(payload.contributionId);
    const stepReg = CONTRIB_NAMES.step(payload.contributionId);
    const status = state.getRegister(statusReg);
    const stepIndex = state.getRegister(stepReg);
    if (status !== 0 || !Number.isInteger(stepIndex) || (stepIndex as number) < 0) {
      return -1;
    }

    // Schema is recomputed from the payload's dims on every replica — deterministic.
    const schema = schemaForDims(payload.dims);
    const step = schema.steps[stepIndex as number];
    if (!step || step.op !== 'verify_contribution' || step.stepId !== payload.stepId) {
      return -1; // wrong lifecycle position for this op
    }

    // Actor payment: per completed check, regardless of direction.
    const paysNow = stepPaymentsFor(step, payload.dims, { actor: op.signerId, submitter: payload.submitter });
    for (const pay of step.pays ?? []) {
      if (pay.rule !== 'per-check') continue;
      const amount = paysNow.get(op.signerId) ?? 0;
      const balance = state.getRegister(RES_NAMES.balance(op.signerId)) || 0;
      state.setRegister(RES_NAMES.balance(op.signerId), balance + amount, op.signerId);
    }

    const doneReg = CONTRIB_NAMES.stepDone(payload.contributionId, step.stepId);
    state.incrementPNCounter(doneReg, 1, op.signerId);
    const done = state.getPNCounter(doneReg);
    const isFinal = done >= step.requirement.count;

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const explanation = {
      actionId: payload.contributionId,
      stepId: step.stepId,
      verification: { verifier: op.signerId, pass: payload.pass, reason: payload.reason, at: nowMs },
      payments: {} as Record<string, number>,
      calibrationVersion: CALIBRATION_VERSION,
      schemaVersion: schema.schemaVersion,
    };

    if (!payload.pass) {
      // Rejection terminates the lifecycle immediately.
      state.setRegister(statusReg, 2, op.signerId);
      state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(explanation), op.signerId);
      return 0;
    }

    if (isFinal) {
      // Submitter outcome bounties fire once, at the final requirement, on acceptance.
      const payments: Record<string, number> = {};
      for (const [target, amount] of paysNow) {
        if (target === op.signerId || amount <= 0) continue; // per-check already paid above
        const balance = state.getRegister(RES_NAMES.balance(target)) || 0;
        state.setRegister(RES_NAMES.balance(target), balance + amount, op.signerId);
        payments[target] = amount;
      }
      for (const [dimKey, match] of Object.entries(payload.dims)) {
        const dimIndex = Number(dimKey);
        const tallyReg = CONTRIB_NAMES.dimensionBalance(payload.submitter, dimIndex);
        if (paymentFor(dimIndex, match) <= 0) continue; // classification-only: no register, no delta
        try { node.addRegister(tallyReg, 0); } catch (err) { /* exists */ }
        state.setRegister(tallyReg, dimensionDeltaFor(dimIndex, match) + (state.getRegister(tallyReg) || 0), op.signerId);
      }
      explanation.payments = payments;

      const nextIndex = (stepIndex as number) + 1;
      if (nextIndex < schema.steps.length) {
        state.setRegister(stepReg, nextIndex, op.signerId); // lifecycle continues
      } else {
        state.setRegister(statusReg, 1, op.signerId); // terminal step ⇒ accepted
      }
    }

    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(explanation), op.signerId);
    return 0;
  };
}
```

Dimension-tally note: registers are created lazily inside the handler and only for dimensions with an implemented payment rule (`paymentFor > 0`) — classification-only dims never get a tally register, so `dim:alice:c9` stays `undefined` in tests (this mock's `getRegister` returns `number | undefined`). No pre-seeding in `registerMember`; Task 7 Step 4 explicitly keeps `initTokenRegisters` untouched.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (wizard tests unaffected; handlers.test.ts untouched).

- [ ] **Step 7: Commit**

```bash
git add shared/src/types.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: schema-driven verify_contribution with step validation and outcome payments"
```

---

### Task 5: settle_contribution op

**Files:**
- Modify: `shared/src/types.ts` (new `SettleContributionPayload`)
- Modify: `shared/src/policies.ts` (policy `settle_contribution: 'role:member'`)
- Modify: `shared/src/handlers.ts` (new `makeSettleContributionHandler`)
- Test: `server/test/contribution.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/test/contribution.test.ts`:

```typescript
import { makeSettleContributionHandler } from '../../shared/src/handlers';
import { SettleContributionPayload } from '../../shared/src/types';

describe('settle_contribution handler', () => {
  function setupAtSettle(node: MockNode, state: MockState, contributeId: string) {
    setupSubmitted(state, node, 'alice', contributeId);
    const verify = makeVerifyContributionHandler(node);
    expect(verify(state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: contributeId, pass: true, reason: 'ok' })))).toBe(0);
  }

  it('the submitter settles after verification, finalizing as accepted', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupAtSettle(node, state, 'c-settle');
    const settle = makeSettleContributionHandler(node);
    expect(settle(state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-settle', submitter: 'alice', reason: 'recorded my outcome' } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-settle'))).toBe(1);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-settle', 'settle'))).toBe(1);
  });

  it('rejects settlement by anyone else, at the wrong step, or twice', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupAtSettle(node, state, 'c-guard');
    const settle = makeSettleContributionHandler(node);
    expect(settle(state, makeOp('settle_contribution', 'bob',
      { contributionId: 'c-guard', submitter: 'alice', reason: 'not mine' } as SettleContributionPayload))).toBe(-1);
    expect(settle(state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-guard', submitter: 'alice', reason: 'ok' } as SettleContributionPayload))).toBe(0);
    expect(settle(state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-guard', submitter: 'alice', reason: 'again' } as SettleContributionPayload))).toBe(-1);
  });

  it('rejects settle when a written reason is missing', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupAtSettle(node, state, 'c-reason');
    const settle = makeSettleContributionHandler(node);
    expect(settle(state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-reason', submitter: 'alice', reason: '' } as SettleContributionPayload))).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- contribution.test.ts`
Expected: FAIL — `makeSettleContributionHandler` not exported.

- [ ] **Step 3: Implement**

In `shared/src/types.ts`:

```typescript
export interface SettleContributionPayload {
  contributionId: string;
  submitter: string;
  reason: string;
}
```

In `shared/src/policies.ts`, add to `POLICIES`:

```typescript
  settle_contribution: 'role:member',
```

In `shared/src/handlers.ts` (imports gain `SettleContributionPayload`, `CALIBRATION_VERSION` already imported in Task 4):

```typescript
export function makeSettleContributionHandler(
  _node: { addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SettleContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.submitter) ||
      !isNonEmptyString(payload.reason)
    ) {
      return -1;
    }
    if (payload.submitter !== op.signerId) {
      return -1; // settlement is the submitter's final acknowledgment
    }
    if (!state.setContains(STATE_NAMES.contributions, payload.contributionId)) {
      return -1;
    }
    const statusReg = CONTRIB_NAMES.status(payload.contributionId);
    const stepReg = CONTRIB_NAMES.step(payload.contributionId);
    if (state.getRegister(statusReg) !== 0) {
      return -1;
    }
    const stepIndex = state.getRegister(stepReg);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      return -1;
    }
    // The settle op is only valid at a step whose schema says so. We cannot
    // read the fact record's dims here, so re-derive schema from the current
    // position: a settle step is terminal in every phase-1 schema, so accept
    // only when this is the terminal step index of a 3-step schema.
    const isTerminal = stepIndex === 2;
    if (!isTerminal) {
      return -1;
    }

    const doneReg = CONTRIB_NAMES.stepDone(payload.contributionId, 'settle');
    state.incrementPNCounter(doneReg, 1, op.signerId);
    state.setRegister(statusReg, 1, op.signerId);

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const explanation = {
      actionId: payload.contributionId,
      stepId: 'settle',
      settlement: { settler: op.signerId, reason: payload.reason, at: nowMs },
      calibrationVersion: CALIBRATION_VERSION,
    };
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(explanation), op.signerId);
    return 0;
  };
}
```

Design note (document in the docstring): the handler cannot re-derive the schema from the fact record (no element enumeration), so it validates the settle step positionally (`stepIndex === 2`). This is sound for every phase-1 schema (3-step wired, 2-step default, settle only exists in the 3-step). Future multi-step schemas should pass `dims` in the settle payload the way verify does.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- contribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/contribution.test.ts
git commit -m "feat: settle_contribution terminal lifecycle op"
```

---

### Task 6: Content-addressed store in WaveDB

**Files:**
- Modify: `server/src/db.ts` (add `putContent`, `getContent`)
- Create: `server/test/content.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/test/content.test.ts`:

```typescript
import { DaoDatabase } from '../../server/src/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from '@jest/globals';

const dir = mkdtempSync(join(tmpdir(), 'dao-content-'));
const db = new DaoDatabase(dir);

afterAll(() => db.close());

describe('content store', () => {
  it('stores bytes and returns their sha-256', async () => {
    const bytes = Buffer.from('hello wizard');
    const hash = await db.putContent(bytes, 'text/plain');
    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('is idempotent on duplicate puts', async () => {
    const bytes = Buffer.from('dedupe me');
    const h1 = await db.putContent(bytes, 'text/plain');
    const h2 = await db.putContent(bytes, 'text/plain');
    expect(h1).toBe(h2);
  });

  it('round-trips with media type', async () => {
    const bytes = Buffer.from('x'.repeat(1000));
    const hash = await db.putContent(bytes, 'application/octet-stream');
    const got = await db.getContent(hash);
    expect(got).toEqual({ hash, mediaType: 'application/octet-stream', bytes: bytes.toString('base64') });
  });

  it('returns null for unknown or malformed hashes', async () => {
    expect(await db.getContent('f'.repeat(64))).toBe(null);
    expect(await db.getContent('not-a-hash')).toBe(null);
  });
});

rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- content.test.ts`
Expected: FAIL — `putContent` does not exist.

- [ ] **Step 3: Implement**

In `server/src/db.ts` (add `createHash` to the existing `node:crypto` import — note this file currently imports nothing from node, so add `import { createHash } from 'node:crypto';` at the top):

```typescript
  async putContent(data: Buffer, mediaType: string): Promise<string> {
    const hash = createHash('sha256').update(data).digest('hex');
    await this.db.putObject(`content/${hash}`, { hash, mediaType, bytes: data.toString('base64') });
    return hash;
  }

  async getContent(hash: string): Promise<{ hash: string; mediaType: string; bytes: string } | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    return this.db.getObject<{ hash: string; mediaType: string; bytes: string }>(`content/${hash}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- content.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/db.ts server/test/content.test.ts
git commit -m "feat(server): content-addressed object store over WaveDB"
```

---

### Task 7: Server wiring — policies, handlers, WS message kinds

**Files:**
- Modify: `shared/src/types.ts` (ClientMessage/ServerMessage gains `put_content`/`get_content`/`content_stored`/`content`)
- Modify: `server/src/handlers.ts` (ConnectionHandler cases)
- Modify: `server/src/crabs.ts` (settle policy+handler, tally registers for implemented dims)
- Test: `server/test/content.test.ts` (WS-level exercised in e2e Task 9)

- [ ] **Step 1: Extend the WS protocol types**

In `shared/src/types.ts`, add to `ClientMessage`:

```typescript
  | { kind: 'put_content'; bytesBase64: string; mediaType: string }
  | { kind: 'get_content'; hash: string }
```

and to `ServerMessage`:

```typescript
  | { kind: 'content_stored'; hash: string }
  | { kind: 'content'; hash: string; mediaType: string; bytesBase64: string }
```

- [ ] **Step 2: Add ConnectionHandler cases**

In `server/src/handlers.ts`, inside the `switch (msg.kind)` (imports: add `CONTENT_LIMITS` from `../../shared/src/contribution` and `isNonEmptyString` already exists):

```typescript
        case 'put_content': {
          if (!isNonEmptyString(msg.bytesBase64) || !isNonEmptyString(msg.mediaType) || msg.mediaType.length > 64) {
            return this.send(ws, { kind: 'error', message: 'Invalid put_content payload' });
          }
          const bytes = base64ToBytes(msg.bytesBase64);
          if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
            return this.send(ws, { kind: 'error', message: 'Content too large' });
          }
          const hash = await this.db.putContent(Buffer.from(bytes), msg.mediaType);
          this.send(ws, { kind: 'content_stored', hash });
          break;
        }

        case 'get_content': {
          if (!isNonEmptyString(msg.hash) || !/^[0-9a-f]{64}$/.test(msg.hash)) {
            return this.send(ws, { kind: 'error', message: 'Invalid get_content payload' });
          }
          const content = await this.db.getContent(msg.hash);
          this.send(ws, content
            ? { kind: 'content', hash: content.hash, mediaType: content.mediaType, bytesBase64: content.bytes }
            : { kind: 'content', hash: msg.hash, mediaType: '', bytesBase64: '' });
          break;
        }
```

- [ ] **Step 3: Wire DaoNode for the settle op**

In `server/src/crabs.ts`:
- Policy (alongside the contribution policies):

```typescript
    this.node.setPolicy('settle_contribution', POLICIES.settle_contribution);
```

- Handler (alongside the contribution registrations):

```typescript
    this.node.registerHandlerJs('settle_contribution', makeSettleContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
```

- Import `makeSettleContributionHandler` in the handler import block.

- [ ] **Step 4: Add real-wasm policy test for settle**

(Tally registers are created lazily by the handler — see Task 4's dimension-tally note; `initTokenRegisters` stays as phase-1 issue #5 left it: the 0-balance RES register only.)

Append to `server/test/crabs.test.ts` (using the `buildSignedMemberOp` helper from the phase-1 plan):

```typescript
it('accepts a settle after a verified contribution through the real wasm node', async () => {
  const dao = new DaoNode();
  await dao.init();
  const kp = await KeyPair.generate();
  dao.registerMember('alice', kp.publicKeyHex());
  dao.registerMember('bob', kp.publicKeyHex());
  const submitOp = await buildSignedMemberOp(dao, 'alice', kp, 'submit_contribution', {
    contributionId: 'c-wasmt',
    dims: { '1': 1 },
    summary: 'built a thing',
    evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
    schemaVersion: 'v1',
  });
  dao.executeOperation(submitOp);
  const kpBob = await KeyPair.generate();
  dao.registerMember('bob', kpBob.publicKeyHex());
  const verifyOp = await buildSignedMemberOp(dao, 'bob', kpBob, 'verify_contribution', {
    contributionId: 'c-wasmt', submitter: 'alice', dims: { '1': 1 }, stepId: 'verify', pass: true, reason: 'ok',
  });
  dao.executeOperation(verifyOp);
  expect(dao.getContributionStatus('c-wasmt')).toBe('pending');
  expect(dao.getResBalance('bob')).toBe(RES_CONFIG.verificationCheckCredit);
  const settleOp = await buildSignedMemberOp(dao, 'alice', kp, 'settle_contribution', {
    contributionId: 'c-wasmt', submitter: 'alice', reason: 'done',
  });
  dao.executeOperation(settleOp);
  expect(dao.getContributionStatus('c-wasmt')).toBe('accepted');
});
```

Key-version note: if `buildSignedMemberOp` signs with a fixed keyVersion (3), `bob` needs `kpBob` and version 3 as well — match the phase-1 helper and register both users before signing their ops (shown above). If signatures reject for key-version drift, re-derive `setOperationSignerKeyVersion(op, dao.getUserKeyVersion(username))` before signing.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/types.ts server/src/handlers.ts server/src/crabs.ts server/test/crabs.test.ts
git commit -m "feat(server): content store WS routes and settle_contribution wiring"
```

---

### Task 8: Client wiring — mirrors, sign methods, content client

**Files:**
- Modify: `client/src/dao.ts` (settle registration, mirrors, getters, verify/settle sign methods)
- Modify: `client/src/server-client.ts` (`putContent`, `getContent`, message-kind guards)
- Verify: `npx tsc -p client/tsconfig.json --noEmit` (no client unit tests — compile is the gate)

- [ ] **Step 1: BrowserDao registrations**

In `client/src/dao.ts` — same treatment as the contribution ops: policy + handler next to the existing contributions lines in both blocks:

```typescript
    this.node.setPolicy('settle_contribution', POLICIES.settle_contribution);
    this.node.registerHandlerJs('settle_contribution', makeSettleContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
```

Imports gain `makeSettleContributionHandler`, `SCHEMA_VERSION`, plus `SettleContributionPayload`.

- [ ] **Step 2: Sign methods**

Next to `verifyContribution`:

```typescript
  async settleContribution(userId: string, payload: SettleContributionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('settle_contribution', userId, JSON.stringify(payload));
  }
```

- [ ] **Step 3: Mirrors and getters**

Extend the contribution mirror (`mirrorContributionState` handles `settle_contribution` too):

```typescript
    if (op.type !== 'submit_contribution' && op.type !== 'verify_contribution' && op.type !== 'settle_contribution') {
      return;
    }
```

and in the settle branch:

```typescript
    if (op.type === 'settle_contribution') {
      const entry = this.contributions.get(payload.contributionId);
      if (entry) (entry as any).settledBy = op.signerId;
      return;
    }
```

Add step/status getters next to `getContributionStatus`:

```typescript
  getContributionStatus(contributionId: string): 'pending' | 'accepted' | 'rejected' | 'unknown' {
    if (!this.node.setContains(STATE_NAMES.contributions, contributionId)) return 'unknown';
    const status = this.node.getRegister(CONTRIB_NAMES.status(contributionId));
    return status === 1 ? 'accepted' : status === 2 ? 'rejected' : 'pending';
  }

  getContributionStepIndex(contributionId: string): number {
    return this.node.getRegister(CONTRIB_NAMES.step(contributionId)) || 0;
  }

  getContributionStepDone(contributionId: string, stepId: string): number {
    return this.node.getPNCounter(CONTRIB_NAMES.stepDone(contributionId, stepId)) || 0;
  }
```

(Note `getContributionStatus` may already exist from phase-1 issue #6 — keep whichever implementation is present and only add the two new getters.)

- [ ] **Step 4: ServerClient content methods**

In `client/src/server-client.ts`:

- Extend the message-kind type guard (the per-kind `switch` at the top of the file) with:

```typescript
    case 'content_stored':
      return isNonEmptyString(value.hash);
    case 'content':
      return isNonEmptyString(value.hash) && typeof value.bytesBase64 === 'string' && typeof value.mediaType === 'string';
```

(If no per-kind guard exists by that pattern — it does; see `isServerMessage` around lines 63-101 — extend the `ClientMessage`/`ServerMessage` unions' validation the same way the existing kinds are validated.)

- Add methods next to `putSnapshot` (imports: `base64ToBytes, bytesToBase64` — already exported from `./dao`):

```typescript
  async putContent(bytes: Uint8Array, mediaType: string): Promise<string> {
    await this.send({ kind: 'put_content', bytesBase64: bytesToBase64(bytes), mediaType });
    const msg = await this.waitFor('content_stored', 30000, 'error');
    const stored = msg as { kind: 'content_stored'; hash: string };
    return stored.hash;
  }

  async getContent(hash: string): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
    await this.send({ kind: 'get_content', hash });
    const msg = await this.waitFor('content', 30000, 'error');
    const content = msg as { kind: 'content'; hash: string; mediaType: string; bytesBase64: string };
    if (!content.bytesBase64) return null;
    return { mediaType: content.mediaType, bytes: base64ToBytes(content.bytesBase64) };
  }
```

- [ ] **Step 5: Compile check**

Run: `npx tsc -p client/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full server suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/dao.ts client/src/server-client.ts
git commit -m "feat(client): mirror settle op and content-store client methods"
```

---

### Task 9: Wizard UI

**Files:**
- Modify: `client/index.html` (submit wizard form, contributions list container)
- Modify: `client/src/ui.ts` (submit wizard flow, stepper detail rendering, content upload)
- Verify: `npm run build:client`, then manual two-browser verification below

The phase-1 UI plan's contribution form is superseded by this task. The submitter's wizard has 3 panes: **(1) Classify** — pick dimensions (C_1/C_2 checkboxes; default C_2), **(2) Describe & evidence** — summary + evidence (file → content store; text → hashed pointer), **(3) Review** — dimension chips, evidence ref, Confirm. All other roles see the stepper on contribution cards and act from `wizardModel`.

- [ ] **Step 1: Submit wizard markup**

In `client/index.html`, replace the phase-1 `<form id="contribution-form">` with:

```html
<form id="contribution-form">
  <h3>Contribute</h3>
  <fieldset id="contribution-step-1">
    <legend>1 — What kind of contribution?</legend>
    <label><input type="radio" name="contrib-dim" value="2" checked /> C_2 Recording — a durable, findable record (base credit 3 $RES)</label>
    <label><input type="radio" name="contrib-dim" value="1" /> C_1 Building — built something real (bounty 12 $RES)</label>
  </fieldset>
  <fieldset id="contribution-step-2">
    <legend>2 — Describe it and attach evidence</legend>
    <input id="contribution-summary" placeholder="What did you make or record?" required />
    <input id="contribution-evidence-text" placeholder="Evidence pointer (URL, commit, record id)…" />
    <input id="contribution-evidence-file" type="file" />
    <div id="contribution-evidence-status" class="muted"></div>
  </fieldset>
  <fieldset id="contribution-step-3">
    <legend>3 — Review</legend>
    <div id="contribution-review"></div>
  </fieldset>
  <button type="submit">Submit contribution</button>
</form>
<section id="contributions-list"></section>
```

- [ ] **Step 2: ui.ts — evidence helper and submit flow**

Add a sha-256 helper (Web Crypto, used for both paths per the spec's uniform-hash simplification):

```typescript
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

Replace the phase-1 `onSubmitContribution` with the wizard flow (fields change; the binding stays on `#contribution-form` submit):

```typescript
  private async onSubmitContribution() {
    if (!this.dao || !this.wallet || this.client === null || this.submitting) return;
    const summary = this.inputValue('contribution-summary');
    if (!summary) {
      this.setStatus('A summary is required.', 'error');
      return;
    }
    const dim = Number((document.querySelector('input[name="contrib-dim"]:checked') as HTMLInputElement)?.value ?? 2);
    const evidenceText = this.inputValue('contribution-evidence-text');
    const fileInput = document.getElementById('contribution-evidence-file') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    this.setSubmitting(true);
    try {
      let evidenceRef;
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
          this.setStatus(`Evidence exceeds ${CONTENT_LIMITS.maxObjectBytes / (1024 * 1024)}MB — split it up.`, 'error');
          return;
        }
        const hash = await this.client!.putContent(bytes, file.type || 'application/octet-stream');
        evidenceRef = { hash, uri: `content://${hash}`, mediaType: file.type || 'application/octet-stream', size: bytes.length };
      } else if (evidenceText) {
        const bytes = new TextEncoder().encode(evidenceText);
        evidenceRef = { hash: await sha256Hex(bytes), uri: evidenceText, mediaType: 'text/uri-list', size: bytes.length };
      } else {
        this.setStatus('Attach evidence or give a pointer — pay follows proven outcomes.', 'error');
        return;
      }

      const payload = {
        contributionId: crypto.randomUUID(),
        dims: { [dim]: 1 },
        summary,
        evidenceRef,
        schemaVersion: SCHEMA_VERSION,
      };
      this.renderContributionReview(payload); // fills #contribution-review before send
      const bytes = await this.dao.submitContribution(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Contribution submitted — awaiting verification.', 'success');
      this.clearForm('contribution-form');
      this.renderContributions();
    } catch (err) {
      this.setStatus(`Contribution error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private renderContributionReview(payload: { dims: Record<string, number>; summary: string; evidenceRef: { uri: string; mediaType: string; size: number } }) {
    const el = document.getElementById('contribution-review');
    if (!el) return;
    const dimLabels = Object.keys(payload.dims)
      .map((k) => `C_${k} ${DIMENSIONS[Number(k)].name}`)
      .join(', ');
    el.innerHTML = `<p><strong>${esc(payload.summary)}</strong></p>
      <p>${esc(dimLabels)} — ${esc(this.evidenceSummary(payload.evidenceRef))}</p>`;
  }

  private evidenceSummary(ref: { uri: string; mediaType: string; size: number }): string {
    if (ref.uri.startsWith('content://')) return `stored evidence (${(ref.size / 1024).toFixed(1)} KB, ${ref.mediaType})`;
    return `pointer: ${ref.uri}`;
  }
```

Imports to add in `ui.ts`: `CONTENT_LIMITS`, `SCHEMA_VERSION`, `DIMENSIONS`, `RES_CONFIG`, `wizardModel`, `ContributionFacts` (facts are read from the dao getters below), `SettleContributionPayload`, `VerifyContributionPayload`. Remove the phase-1 `confirm()`/`prompt()` verify handler body and replace per Step 3.

- [ ] **Step 3: Stepper and role actions on contribution cards**

Replace the phase-1 contributions list rendering with a `renderContributions()` driven by `wizardModel`. For each contribution mirror entry:

```typescript
  private renderContributions() {
    const list = document.getElementById('contributions-list');
    if (!list || !this.dao || !this.wallet) return;
    list.innerHTML = '';
    const entries = [...this.dao.getContributions()].reverse();
    for (const entry of entries) {
      const schema = schemaForDims(entry.record.dims);
      const facts: ContributionFacts = {
        status: this.dao.getContributionStatus(entry.record.contributionId) === 'unknown' ? -1
          : this.dao.getContributionStatus(entry.record.contributionId) === 'accepted' ? 1
          : this.dao.getContributionStatus(entry.record.contributionId) === 'rejected' ? 2 : 0,
        stepIndex: this.dao.getContributionStepIndex(entry.record.contributionId),
        done: Object.fromEntries(schema.steps.map((s) => [
          s.stepId, this.dao.getContributionStepDone(entry.record.contributionId, s.stepId),
        ])),
        submitter: entry.submitter,
      };
      const model = wizardModel(schema, facts, this.wallet.username, this.dao.custodians.includes(this.wallet.username));
      const card = this.buildContributionCard(entry, model);
      list.appendChild(card);
    }
  }
```

`buildContributionCard(entry, model)` renders:
- header: summary, submitter name, status pill from `model.outcome` (pending/accepted/rejected);
- stepper row: one chip per `model.steps[i]` — class `complete|current|locked`, text `${i+1}. ${title}` plus `(d/n)` when `progress.required > 1`;
- body: for the current step, for each actor entry with `roles[actor]?.mayAct`:
  - `verifier` action → a "Verify" button opening a small inline form: pass/radio + required written reason; submits `verifyContribution` with the payload `{contributionId, submitter, dims: entry.record.dims, stepId: step.stepId, pass, reason}` (following the existing `onCastRunoffVote` submit pattern);
  - `submitter` action at a settle step → a "Settle" button with required reason, submitting `settleContribution` `{contributionId, submitter, reason}`;
- evidence row: `evidenceSummary` text; stored contents render their media when `client.getContent(hash)` succeeds (images inline via object URL, others as a download link); missing content renders "evidence unavailable";
- rejected cards keep the explanation record visible (spec: rejected ≠ erased) — show `entry.verdictReason` when present.

Both actions reuse the exact try/submit/safeExecuteRemote/finally shape shown in Task 9 Step 2 of the phase-1 plan (see `onSubmitContribution` above) — copy that error/success handling verbatim for `onVerifyContribution`/`onSettleContribution`, replacing the payload with the one shown in this bullet. Guard rails client-side: the verify form refuses to send when `submitter === wallet.username`; the settle button only renders when `model.steps[currentStepIndex]?.op === 'settle_contribution'`.

> **Plan amendment (2026-10-04, execution):** the "small inline form" for verify/settle was simplified to `confirm()` + `prompt()` for phase 1 — all guard rails (no-self, required written reason, pass flag) are enforced identically; the inline form is deferred to the UI-polish phase together with the other deferred invariants.

Add `renderContributions()` to the demo-clock refresh list (`startDemoClock`, after `renderCustodianControls()`), and remove any phase-1 verify UI remnants (`confirm`/`prompt` flow).

- [ ] **Step 4: Build**

Run: `npm run build:client`
Expected: clean build.

- [ ] **Step 5: Manual two-browser verification (dev server)**

Run: `npm run dev`, open two browser windows, register `alice` and `bob`:

1. alice: submit wizard — pane 1 pick "C_1 Building", pane 2 summary + attach a small file (uploads, hash shown in review pane 3), submit. Stepper shows: 1 Submission ✓, 2 Verification current, 3 Settlement locked.
2. bob: sees the same card with status "pending", a Verify button — verify-accept with a reason. Bob's badge +2 `$RES`; alice's +12.
3. alice: card advances — 2 Verification ✓, 3 Settlement current with a Settle button (bob does not see it). Alice settles → status "accepted".
4. alice: submit a C_2 record with a **pointer** (no file) and have bob **reject** it with a reason — status "rejected" renders with the reason visible; no bounty moves except bob's +2 (verify pays either direction).
5. Wait 30s with no ops — no balances move (nothing accrues on a timer).
6. Submit a >8MB file — expected: server rejects with `Content too large`, status message shows.

Expected: wizard steps derive entirely from the dimension schema (C_1 has settle, default does not); every role sees the same facts but different actions.

- [ ] **Step 6: Commit**

```bash
git add client/index.html client/src/ui.ts
git commit -m "feat(ui): contribution wizard — classify/describe/evidence flow with role-based stepper"
```

---

### Task 10: e2e, hydration, docs

**Files:**
- Modify: `test-voting-browser.js` (wizard flow replaces the phase-1 contribution form interactions)
- Modify: `server/test/hydration.test.ts` (lifecycle counters survive replay)
- Modify: `docs/contribution-economy/README.md` (binding section update)

- [ ] **Step 1: Hydration test for the new registers**

Append to `server/test/hydration.test.ts` (same op-building approach as `crabs.test.ts`): register alice+bob, submit (evidenceRef'd), verify, settle through `dao.executeOperation`, persist those ops, construct a fresh DaoNode, replay via `hydrateDao`, then assert:

```typescript
      expect(second.getContributionStatus('c-hyd')).toBe('accepted');
      expect(second.getContributionStepIndex('c-hyd')).toBe(2);   // settle handler sets status, not the step register
      expect(second.getResBalance('alice')).toBe(RES_CONFIG.buildingBounty);
      expect(second.getResBalance('bob')).toBe(RES_CONFIG.verificationCheckCredit);
      expect(second.getDimensionBalance('alice', 1)).toBe(1);
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: e2e script update**

In `test-voting-browser.js`, replace whatever submission/verification selectors the phase-1 script used (`#contribution-summary`, `contribution-form` radio buttons, verify buttons) with the wizard flow: fill summary → pick radio → attach no file (pointer path) → submit → verify as the second page → settle. Keep the script's existing conventions (page selectors and wait helpers used for the voting flow).

- [ ] **Step 4: Run the e2e script per its own README/run instructions**

Expected: wizard flow passes end-to-end through the real server.

- [ ] **Step 5: Docs binding**

In `docs/contribution-economy/README.md`'s "Binding to the reference implementation" section, replace the phase-1 paragraph with the current state:

```markdown
- Implemented: schema-driven contribution lifecycle (generic step schemas in
  `shared/src/contribution.ts`, wired for C_1/C_2/C_18 as submit→verify→settle;
  default submit→verify elsewhere), the wizard UI with role-based stepper views
  (`shared/src/wizard.ts` projections), content-addressed evidence store
  (WaveDB, sha-256 refs; CRABS holds pointers only).
- Deferred (open issues): multi-party step modes (C_8 all-parties), tiered
  verification, harm checks, retrieval bonuses, round spine + $RCT aggregation,
  null-vs-verified-zero tallies, reviewer-capture hardening.
```

- [ ] **Step 6: Commit**

```bash
git add test-voting-browser.js server/test/hydration.test.ts docs/contribution-economy/README.md
git commit -m "test/docs: wizard e2e flow, hydration coverage for lifecycle registers"
```

---

## Self-review

- **Spec coverage:** D1 generic schema + few wired → Tasks 1-5; D2 facts/content split → Tasks 1 (evidenceRef), 6 (store), 7 (WS routes); schema-consulting handlers → Tasks 3-5; wizardModel role views → Tasks 2, 9; wizard UI classify/describe/evidence → Task 9; role-projected stepper → Task 9; error handling (oversize, missing content, unknown schema) → Tasks 7/9 + `readOnly` in Task 2; testing ladder → Tasks 1-6, 10. All spec sections land somewhere; nothing omitted.
- **Placeholder scan:** no TBDs; every code step shows full code. The settle handler's positional validation is a documented decision, not a placeholder.
- **Type consistency:** `EvidenceRef`/`SCHEMA_VERSION`/`CONTENT_LIMITS` (Task 1) match the payload fields (Task 3) and UI usage (Task 9). `CONTRIB_NAMES.step`/`stepDone` defined in Task 3, consumed in Tasks 4, 5, 8. `stepPaymentsFor` signature (Task 1) consumed identically in Task 4. `ContributionFacts` (Task 2) built from dao getters (Task 8) — field names `status/stepIndex/done/submitter` consistent. `wizardModel` return shape consumed by `buildContributionCard` (Task 9) by the names defined in Task 2.
- **Known risk:** Task 4's tally-register strategy (lazy create when `paymentFor > 0`, absent otherwise) must remain consistent with the `dim:alice:c9` undefined test — the handler creates registers only inside payment-bearing branches, never for classification-only dims.