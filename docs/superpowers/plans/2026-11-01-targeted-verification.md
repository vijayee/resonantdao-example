# Targeted Verification (Slice #4c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contributions name their verifiers at submission (protocol state): submit payload gains `verifiers` (validated/count-exact), an OR-set register holds the assignment, the verify handler rejects unnamed signers, a submitter-only `reassign_verifiers` op adds replacement names, the wizard gains the screened members-pick step, and waiting text becomes determinate for targeted flows.

**Architecture:** Protocol first (shared/src handlers + policies + types + feed), then projection (wizard.ts targeting + lifecycle.ts names), then the 'members' shell step kind + wizard wiring, then e2e. Legacy payloads without the field keep the untargeted class rule — every pre-existing test intact.

**Tech Stack:** shared TS (jest + ts-jest, TDD), Vue 3 SFC + pinia, Playwright e2e.

Spec: `docs/superpowers/specs/2026-11-01-targeted-verification-design.md`

---

## Conventions

- npm from repo root; commits direct to master; never stage outside the task list; SFC trailing newlines; jest suites in `server/test/` (MockNode/MockState helpers live in `server/test/handlers.test.ts:19-90` — reuse them via import where the file already exports them, or copy the established pattern).
- Handler pattern reference: `state.setAdd(name, element, uniqueTagPerAdd)` writes OR-sets; `node.addORSet/addRegister/addPNCounter` declare resources (try/catch duplicate ignored); `state.getRegister` reads; the op name → `registerHandlerJs('<op>', makeXHandler(node, config))` in BOTH `server/src/crabs.ts` and `client/src/dao.ts` init blocks (the paired registrations — check both when adding any).
- Known-red windows are called out per task; TDD strictly at pure seams.

## Final file layout

```
Created:
  server/test/targeted-verification.test.ts    # handler + projection suite (TDD)
Modified:
  shared/src/policies.ts                       # CONTRIB_NAMES.verifiers + :verifierCount + :step? (no — step exists)
  shared/src/types.ts                          # ContributionPayload.verifiers?: string[]; ReassignVerifiersPayload
  shared/src/handlers.ts                       # submit validation/register write; reassign_verifiers handler; verify gate
  shared/src/feed.ts                           # CONSEQUENTIAL_OPS + reassign builder case
  shared/src/wizard.ts                         # facts.verifiers → targeted mayAct (+ legacy fallback)
  server/test/wizard.test.ts, lifecycle.test.ts# targeting/waiting-name tests (amendments)
  client/src/wizard/types.ts                   # 'members' step kind (count fn-able) (TDD)
  server/test/wizard-steps.test.ts             # members validation tests
  client/src/wizard/WizardFlow.vue             # members step rendering
  client/src/wizard/lifecycle.ts               # targeted waiting names
  client/src/dao.ts                            # reassignVerifiers builder + getDefinedVerifiers accessor + registerHandlerJs pairing
  client/src/stores/dao.ts                     # submitContribution verifiers param + reassignVerifiers op + facts.verifiers assembly
  client/src/wizard/flows/contribute-flows.ts  # contributeNewFlow members step + reassignFlow factory
  client/src/components/contribute/ContributionPage.vue  # reassign section
  test-voting-browser.js                       # members-step driving + determinate-band asserts
```

---

## Task 1: state machine — submit validation + the verifiers register (TDD)

**Files:**
- Modify: `shared/src/policies.ts` (CONTRIB_NAMES)
- Modify: `shared/src/types.ts` (payload type)
- Modify: `shared/src/handlers.ts` (submit gate + register write)
- Test: `server/test/targeted-verification.test.ts` (new suite; reuse the MockNode/MockState helper classes — copy their pattern from `server/test/handlers.test.ts:19-90` into the new file's header or import if exported)

- [ ] **Step 1: failing tests** — `server/test/targeted-verification.test.ts` (structure; use the EXACT helper idioms of handlers.test.ts — read that file first and follow its MockNode/MockState/setup shape; the assertions below are the contract):

```ts
// Contract (each an `it`):
// A. submit with verifiers ['bob'] (C_2 payload, alice signer): ACCEPTED; the
//    verifiers OR-set contains bob (state.setContains true) and the count
//    register reads 1; the OWNER set contains alice (setContains true).
// B. submit with verifiers ['alice'] (self-named) → -1.
// C. submit with verifiers ['ghost'] (not a member) → -1.
// D. submit with verifiers ['bob','bob'] (duplicate) → -1.
// E. C_1 payload (verify count 2) with exactly 2 names → ACCEPTED; with 1 → -1.
// F. submit WITHOUT the verifiers field (legacy shape) → ACCEPTED and the
//    count register reads 0 (untargeted) — pre-existing behavior byte-identical.
```

(Write these as real tests against `makeSubmitContributionHandler` with the MockState seeded: members or-set contains alice/bob/carol/dave; schema v2 payloads. Follow handlers.test.ts's payload fixtures.)

- [ ] **Step 2: run to FAIL** — `npx jest server/test/targeted-verification.test.ts --runInBand` → FAIL (no verifier register/handling).

- [ ] **Step 3: implement** —
  `shared/src/policies.ts` — inside CONTRIB_NAMES:

```ts
  // The NAMED verifiers (targeted verification): submit records the initial
  // names; reassign_verifiers grows the set. Empty → untargeted (class rule).
  verifiers: (contributionId: string) => `contrib:${contributionId}:v`,
  // Numeric companion: >0 marks the contribution TARGETED (the handler can't
  // enumerate a set — presence of a >0 count is the targeting bit).
  verifierCount: (contributionId: string) => `contrib:${contributionId}:vc`,
  // The verify step's requirement count, stamped by submit (handlers can't
  // enumerate sets, so reassign reads requirement state from registers).
  verifyCount: (contributionId: string) => `contrib:${contributionId}:vneed`,
  // The TRUE submitter, recorded by the machine (single-element OR-set).
  // Settle/appeal today authenticate only payload-claim === signer (forgeable
  // — FLAGGED 2026-11-01 as a follow-up protocol fix); reassign authenticates
  // against THIS.
  owner: (contributionId: string) => `contrib:${contributionId}:owner`,
```

  `shared/src/types.ts` — on the submit payload type (`ContributionPayload`):

```ts
  // Targeted verification (slice #4c): the submitter names exactly
  // schema-requirement.count verifiers. ABSENT (or the field missing) keeps
  // legacy untargeted behavior — any non-submitter member may verify.
  verifiers?: string[];
```

  `shared/src/handlers.ts` — in `makeSubmitContributionHandler`, after the existing validation block (before schema lookup) add:

```ts
    // Targeted verification (slice #4c): when the payload names verifiers,
    // they must be pairwise-distinct members ≠ the submitter, exactly the
    // wired schema's verify requirement count. Absent field = untargeted.
    if (payload.verifiers !== undefined) {
      if (
        !Array.isArray(payload.verifiers) ||
        payload.verifiers.length === 0 ||
        new Set(payload.verifiers).size !== payload.verifiers.length ||
        payload.verifiers.includes(op.signerId) ||
        payload.verifiers.some((v) => !isNonEmptyString(v) || !state.setContains(STATE_NAMES.members, v))
      ) {
        return -1;
      }
    }
```

  and after `const schema = schemaForRecord(payload.schemaVersion, payload.dims);` add the count-exactness gate:

```ts
    if (payload.verifiers !== undefined) {
      const verifyStep = schema.steps.find((s) => s.op === 'verify_contribution');
      if (!verifyStep || payload.verifiers.length !== verifyStep.requirement.count) return -1;
    }
```

  and after the stepDone declaring loop add the register writes:

```ts
    try { node.addORSet(CONTRIB_NAMES.verifiers(payload.contributionId)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(CONTRIB_NAMES.owner(payload.contributionId)); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(CONTRIB_NAMES.verifierCount(payload.contributionId), 0); } catch (err) { /* ignore duplicate */ }
    state.setAdd(CONTRIB_NAMES.owner(payload.contributionId), op.signerId, `submit:owner:${op.signerId}`);
    const verifyStep = schema.steps.find((s) => s.op === 'verify_contribution')!;
    try { node.addRegister(CONTRIB_NAMES.verifyCount(payload.contributionId), verifyStep.requirement.count); } catch (err) { /* ignore duplicate */ }
    if (payload.verifiers !== undefined) {
      for (const v of payload.verifiers) {
        state.setAdd(CONTRIB_NAMES.verifiers(payload.contributionId), v, `submit:${op.signerId}:${v}`);
      }
      state.setRegister(CONTRIB_NAMES.verifierCount(payload.contributionId), payload.verifiers.length, op.signerId);
    }
```

- [ ] **Step 4: run to PASS + full jest** — targeted suite green; `npm test` green (all pre-existing suites intact — legacy shape untouched).

- [ ] **Step 5: commit**

```bash
git add shared/src/policies.ts shared/src/types.ts shared/src/handlers.ts server/test/targeted-verification.test.ts
git commit -m "feat(state): submit names verifiers — validated, count-exact, into the OR-set (TDD)"
```

---

## Task 2: `reassign_verifiers` op (TDD)

**Files:**
- Modify: `shared/src/types.ts` (+ ReassignVerifiersPayload)
- Modify: `shared/src/handlers.ts` (+ makeReassignVerifiersHandler)
- Modify: `server/src/crabs.ts` + `client/src/dao.ts` (registerHandlerJs pairing — BOTH)
- Test: `server/test/targeted-verification.test.ts`

- [ ] **Step 1: failing tests** (append):

```ts
// Contract:
// G. alice's reassign on her C_2 contribution (verify incomplete, bob named)
//    with verifiers ['carol'] (remaining = 1−0 = 1) → ACCEPTED; the set now
//    contains bob AND carol; count reads 2.
// H. reassign NOT by the submitter (bob reassigns alice's) → -1.
// I. reassign with the WRONG remaining count (C_1 2-of, 1 done → naming 2)
//    → -1; (naming 0) → -1.
// J. reassign naming a non-member / self / duplicate name → -1.
// K. reassign after the verify step COMPLETED → -1.
// L. reassign on an UNTARGETED contribution (count register 0/absent) → -1.
```

- [ ] **Step 2: run to FAIL.**

- [ ] **Step 3: implement** — types:

```ts
export interface ReassignVerifiersPayload {
  contributionId: string;
  verifiers: string[];   // the NEW names only — added to the existing set
}
```

  handler (follow the settled/appeal handlers' shape; register `makeReassignVerifiersHandler(node, config)`; registered as `'reassign_verifiers'` in BOTH `server/src/crabs.ts` and `client/src/dao.ts` init, next to the settle registration):

```ts
export function makeReassignVerifiersHandler(
  node: { addORSet(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ReassignVerifiersPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.contributionId) || !Array.isArray(payload.verifiers)) return -1;
    try { node.addORSet(CONTRIB_NAMES.verifiers(payload.contributionId)); } catch (err) { /* replay idempotence */ }
    try { node.addRegister(CONTRIB_NAMES.verifierCount(payload.contributionId), 0); } catch (err) { /* replay idempotence */ }
    // Targeted only: an untargeted contribution (count 0/absent) reassigns nothing.
    const targetCount = state.getRegister(CONTRIB_NAMES.verifierCount(payload.contributionId)) ?? 0;
    if (targetCount <= 0) return -1;
    const status = state.getRegister(CONTRIB_NAMES.status(payload.contributionId));
    if (status === undefined || (status !== STATUS_PENDING && status !== STATUS_APPEALED)) return -1;
    // Submitter-ONLY, authenticated against the machine's owner set (the
    // payload-claim pattern settle/appeal use is the flagged forgeable gap;
    // this op does better). Owner/verifyCount OR-set+registers are declared
    // by submit at Task 1; the defensive declares are replay idempotence.
    try { node.addORSet(CONTRIB_NAMES.owner(payload.contributionId)); } catch (err) { /* replay idempotence */ }
    if (!state.setContains(CONTRIB_NAMES.owner(payload.contributionId), op.signerId)) return -1;
    // ...only while verification has remaining slots — requirement state
    // lives in registers (handlers cannot enumerate sets):
    const need = state.getRegister(CONTRIB_NAMES.verifyCount(payload.contributionId)) ?? 0;
    if (need <= 0) return -1;
    const done = state.getPNCounter(CONTRIB_NAMES.stepDone(payload.contributionId, 'verify')) || 0;
    const remaining = need - done;
    if (remaining <= 0) return -1;   // K
    if (!Array.isArray(payload.verifiers) || payload.verifiers.length !== remaining) return -1;
    if (
      new Set(payload.verifiers).size !== payload.verifiers.length ||
      payload.verifiers.includes(op.signerId) ||
      payload.verifiers.some((v) => !isNonEmptyString(v) || !state.setContains(STATE_NAMES.members, v))
    ) return -1;
    // Grow-only: a name already in the set must not be re-added (setAdd would
    // silently drop it, silently shrinking the remaining count).
    for (const v of payload.verifiers) {
      if (state.setContains(CONTRIB_NAMES.verifiers(payload.contributionId), v)) return -1;
    }
    for (const v of payload.verifiers) {
      state.setAdd(CONTRIB_NAMES.verifiers(payload.contributionId), v, `reassign:${op.signerId}:${v}`);
    }
    state.setRegister(CONTRIB_NAMES.verifierCount(payload.contributionId), targetCount + payload.verifiers.length, op.signerId);
    return 0;
  };
}
```

- [ ] **Step 4: run to PASS + full jest green.**

- [ ] **Step 5: commit**

```bash
git add shared/src/types.ts shared/src/handlers.ts server/src/crabs.ts client/src/dao.ts server/test/targeted-verification.test.ts
git commit -m "feat(state): reassign_verifiers — submitter adds remaining verifiers (TDD)"
```

---

## Task 3: the verify handler's targeted gate (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (verify handler)
- Test: `server/test/targeted-verification.test.ts`

- [ ] **Step 1: failing tests** (append):

```ts
// Contract:
// M. bob (NAMED, unbarred) verifies alice's targeted C_2 → ACCEPTED (0).
// N. carol (UNNAMED member, otherwise eligible) verifies → -1. THE protocol
//    core: only a named verifier may change the state.
// O. UNTARGETED contribution: carol verifies → ACCEPTED (legacy rule intact).
// P. Appeal rewind: after an appeal + re-verify, the SAME named verifier
//    verifies → ACCEPTED (the set survives the appeal).
```

- [ ] **Step 2: run to FAIL.**

- [ ] **Step 3: implement** — in `makeVerifyContributionHandler`, after the existing no-self/membership checks and BEFORE the reciprocity check, add:

```ts
    // Targeted verification: when the named set is non-empty, ONLY named
    // verifiers may act (the set itself carries targeting; the empty case is
    // the untargeted legacy rule).
    const targetCount = state.getRegister(CONTRIB_NAMES.verifierCount(payload.contributionId)) ?? 0;
    if (targetCount > 0 && !state.setContains(CONTRIB_NAMES.verifiers(payload.contributionId), op.signerId)) {
      return -1;
    }
```

(the register needs declaring defensively on replay: wrap a
`try { node.addRegister(CONTRIB_NAMES.verifierCount(...), 0); } catch {}` — check the verify
handler's existing `node` param signature (it declares resources?) and follow its pattern.)

- [ ] **Step 4: PASS + full jest green.**

- [ ] **Step 5: commit**

```bash
git add shared/src/handlers.ts server/test/targeted-verification.test.ts
git commit -m "feat(state): the verify gate honors the named set (TDD)"
```

---

## Task 4: feed — the reassign row (TDD)

**Files:**
- Modify: `shared/src/feed.ts`
- Test: `server/test/feed.test.ts`

- [ ] **Step 1: failing tests** (append to feed.test.ts, its existing style):

```ts
  it('maps reassign_verifiers with the named names', () => {
    const ev = feedEventFromOp(
      'reassign_verifiers', 'alice',
      JSON.stringify({ contributionId: 'c-1', verifiers: ['carol', 'dave'] }), 7000, 1, 20,
    ) as FeedEvent;
    expect(ev!.type).toBe('verifiers_reassigned');
    expect(ev!.summary).toBe('alice named carol & dave as additional verifier(s)');
    expect(ev!.targetId).toBe('c-1');
  });
```

  and extend the consequential-op-set test's expectation list with `'reassign_verifiers'`.

- [ ] **Step 2: FAIL → implement** — `FeedEventType` gains `'verifiers_reassigned'`; `OP_TO_EVENT.reassign_verifiers = 'verifiers_reassigned'`; `CONSEQUENTIAL_OPS` gains the op; the builder case:

```ts
    case 'reassign_verifiers': {
      const names = Array.isArray(payload.verifiers) ? payload.verifiers as string[] : [];
      return {
        ...base,
        summary: `${signerId} named ${names.join(' & ') || 'no-one'} as additional verifier(s)`,
        targetId: typeof payload.contributionId === 'string' ? payload.contributionId : undefined,
      };
    }
```

- [ ] **Step 3: PASS + full jest.** Commit:

```bash
git add shared/src/feed.ts server/test/feed.test.ts
git commit -m "feat(feed): the reassign event mirrors who named whom (TDD)"
```

---

## Task 5: projection — targeting in wizardModel + determinate waiting (TDD)

**Files:**
- Modify: `shared/src/wizard.ts` (facts.verifiers + verify mayAct)
- Modify: `client/src/wizard/lifecycle.ts` (targeted waiting text)
- Test: `server/test/wizard.test.ts` + `server/test/lifecycle.test.ts`

- [ ] **Step 1: failing tests.** In `server/test/wizard.test.ts` (its existing style):

```ts
  it('targeted verify: only a NAMED verifier may act; unnamed eligible members locked out', () => {
    const m = wizardModel(SCHEMAS.get(2)!, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice', verifiers: ['bob'] }, 'carol');
    expect(m.steps[1].roles['verifier']?.mayAct).toBe(false);
    const named = wizardModel(SCHEMAS.get(2)!, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice', verifiers: ['carol'] }, 'carol');
    expect(named.steps[1].roles['verifier']?.mayAct).toBe(true);
    // untargeted (no field): the legacy class rule stands
    const legacy = wizardModel(SCHEMAS.get(2)!, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice' }, 'carol');
    expect(legacy.steps[1].roles['verifier']?.mayAct).toBe(true);
  });
```

  In `server/test/lifecycle.test.ts` (amends the #4b never-a-name tests to the amended rule):

```ts
  it('targeted verify waits on NAMED people; untargeted keeps the role text', () => {
    const targeted = lifecycleModel(schema, facts(1, { submit: 1, verify: 0 }), entry({ verifiedBy: undefined, verifiers: undefined }), 'dave', false, []);
    // facts carry the targeting — the waiting text names the remaining:
    const t2 = lifecycleModel(schema, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice', verifiers: ['bob'] }, entry(), 'dave', false, []);
    expect(t2.phases[1].waitingOn).toMatch(/bob/);
    const legacy = lifecycleModel(schema, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice' }, entry(), 'dave', false, []);
    expect(legacy.phases[1].waitingOn).toMatch(/verifier/i);
    expect(legacy.phases[1].waitingOn).not.toMatch(/bob|carol|dave/);
  });
```

- [ ] **Step 2: run to FAIL.**

- [ ] **Step 3: implement.** `shared/src/wizard.ts`: `ContributionFacts` gains `verifiers?: string[]` (comment: the NAMED assignment; empty/absent = untargeted legacy class rule); in `actorMayAct` (or its verify-specific path — read the existing verify no-self rule first: the class rule is `viewerId !== facts.submitter` for verifiers) — the verify actor branch becomes:

```ts
    case 'verifier':
      // Targeted: the named set is the gate (the machine enforces it — the
      // projection only mirrors the rule). Legacy: class rule (any non-self).
      if (facts.verifiers !== undefined && facts.verifiers.length > 0) {
        return facts.verifiers.includes(viewerId);
      }
      return viewerId !== facts.submitter;
```

(match the file's actual structure — read `actorAllowed`/`actorMayAct` first and thread the rule through the same switch).

  `client/src/wizard/lifecycle.ts`: `WAITING_TEXT` for verify becomes determinate when facts.verifiers non-empty — `phaseFor` needs the facts: thread `facts` into `phaseFor` (signature grows) and set:

```ts
    // Targeted verification makes the actor DETERMINATE (state!) — waiting
    // names the remaining named verifiers; legacy keeps the role text.
    waitingOn: step.state === 'current' && !mayAct ? waitingText(step, facts, entry) : undefined,
```

```ts
function waitingText(step: WizardStep, facts: ContributionFacts, entry: ContributionMirrorEntry): string {
  if (step.stepId === 'verify' && facts.verifiers && facts.verifiers.length > 0) {
    const verified = entry.verifiers ?? [];
    const remaining = facts.verifiers.filter((v) => !verified.includes(v));
    return remaining.length > 0 ? `awaiting ${remaining.join(' & ')}` : 'awaiting a verification';
  }
  return WAITING_TEXT[step.stepId] ?? 'awaiting the next step';
}
```

  (Adjust the #4b tests' now-unmatched waiting assertions ONLY where the contract changed — targeted names, untargated role text — and keep the isParticipant suite intact: an NAMED verifier is a participant via mayAct ✓.)

- [ ] **Step 4: PASS + full jest green.** Commit:

```bash
git add shared/src/wizard.ts client/src/wizard/lifecycle.ts server/test/wizard.test.ts server/test/lifecycle.test.ts
git commit -m "feat(wizard): targeted verify projection — named gate + determinate waiting (TDD)"
```

---

## Task 6: the `'members'` shell step kind (TDD)

**Files:**
- Modify: `client/src/wizard/types.ts`
- Modify: `client/src/wizard/WizardFlow.vue`
- Test: `server/test/wizard-steps.test.ts`

- [ ] **Step 1: failing tests** (append):

```ts
  it('members steps require EXACTLY count selections', () => {
    const fixed: FlowStep = { kind: 'members', id: 'verifiers', title: 'Verifiers', count: 1 };
    const dynamic: FlowStep = { kind: 'members', id: 'verifiers', title: 'Verifiers', count: (a) => Number(a.dim === '1' ? 2 : 1) };
    expect(validateStep(fixed, {})).toBe('Choose exactly 1 verifier(s).');
    expect(validateStep(fixed, { verifiers: 'bob' })).toBeNull();
    expect(validateStep(dynamic, { dim: '1', verifiers: 'bob' })).toBe('Choose exactly 2 verifier(s).');
    expect(validateStep(dynamic, { dim: '1', verifiers: 'bob,carol' })).toBeNull();
  });
```

- [ ] **Step 2: FAIL → implement.** `types.ts` union member:

```ts
  | { kind: 'members'; id: string; title: string; count: number | ((answers: FlowAnswers) => number) }
```

  `validateStep` members branch (answers serialize the selection as a comma-joined string):

```ts
  if (step.kind === 'members') {
    const need = typeof step.count === 'function' ? step.count(answers) : step.count;
    const got = (answers[step.id] ?? '').split(',').filter(Boolean).length;
    return got === need ? null : `Choose exactly ${need} verifier(s).`;
  }
```

  `WizardFlow.vue`: a members branch in the body (after the evidence branch):

```vue
      <fieldset v-else-if="current.kind === 'members'" class="wizard-fieldset" :id="`wizard-${flow.id}-${current.id}`">
        <legend>{{ current.title }}</legend>
        <label v-for="opt in memberOptions" :key="opt" class="wizard-choice">
          <input type="checkbox" :class="`wizard-member wizard-member--${current.id}`" :value="opt" :checked="(answers[currentStepId] ?? '').split(',').includes(opt)" @change="toggleMember(current.id, opt, $event)" />
          <span>{{ opt }}</span>
        </label>
      </fieldset>
```

  script (the offered list comes from the FLOW — no: the options are the FACTORY's business; the shell renders `step.options` — so the members kind ALSO carries `options: string[]` (the screened eligible list) — CORRECTION: the kind is

```ts
  | { kind: 'members'; id: string; title: string; options: string[]; count: number | ((answers: FlowAnswers) => number) }
```

  and the template iterates `current.options` while disabled options stay out of the list
  entirely (the factory screens; greyed-with-reason is a factory desc concern — the current
  schemas' pick lists simply OMIT ineligible members; the visible dead-end (zero eligible) is
  the factory's empty-options step rendering with its own notice — the plan's Task 7 covers
  it). `toggleMember`:

```ts
function toggleMember(stepId: string, name: string, ev: Event): void {
  const picked = new Set((answers.value[stepId] ?? '').split(',').filter(Boolean));
  const on = (ev.target as HTMLInputElement).checked;
  if (on) picked.add(name); else picked.delete(name);
  answers.value = { ...answers.value, [stepId]: [...picked].join(',') };
}
```

- [ ] **Step 3: PASS + full jest + typecheck.** Commit:

```bash
git add client/src/wizard/types.ts client/src/wizard/WizardFlow.vue server/test/wizard-steps.test.ts
git commit -m "feat(wizard): the members picker step — screened list, exact-count validation (TDD)"
```

---

## Task 7: store + dao — payload, accessor, op wrapper

**Files:**
- Modify: `client/src/dao.ts` (reassign builder + getDefinedVerifiers + handler registration)
- Modify: `client/src/stores/dao.ts` (submit param + reassign op + facts.verifiers)

- [ ] **Step 1: `client/src/dao.ts`** — next to the other op builders:

```ts
  async reassignVerifiers(userId: string, payload: ReassignVerifiersPayload): Promise<Uint8Array> {
    return this.signAndSerialize('reassign_verifiers', userId, JSON.stringify(payload));
  }
```

  (import ReassignVerifiersPayload from '@shared/types'; register the handler in init — the
  server pairing already landed in Task 2: `this.node.registerHandlerJs('reassign_verifiers', makeReassignVerifiersHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));`)

  accessor (near getContributionAppealed; the member-scan read pattern):

```ts
  getDefinedVerifiers(contributionId: string): string[] {
    const count = this.getRegisterValue?.(CONTRIB_NAMES.verifierCount(contributionId)) ?? this.readRegisterFallback(CONTRIB_NAMES.verifierCount(contributionId));
    if (count <= 0) return [];
    return (this.knownMembers ?? []).filter((m) => this.node.setContains(CONTRIB_NAMES.verifiers(contributionId), m));
  }
```

  CORRECTION (resolve while implementing): read the file's actual register-read + member-list
  idioms (how getVerifierStats/other accessors read registers and where the known member list
  comes from — likely `this.node` scan like the elections candidate read at dao.ts:530) and
  write the accessor in THAT idiom; the CONTRACT is: returns [] for untargeted (count ≤ 0),
  the named member list otherwise.

- [ ] **Step 2: `client/src/stores/dao.ts`** — `submitContribution(summary, dim, evidenceFile, evidenceText, verifiers: string[])` (5th param; payload gains `...(verifiers.length ? { verifiers } : {})`); a new op function `reassignVerifiers(contributionId, verifiers: string[]): Promise<boolean>` (boolean contract: submitOp → safeExecuteRemote → `status.set('Additional verifiers named.', 'success'); bump(); return true` / guards `return false`); the facts assembly (`contributionFacts`) gains

```ts
    // The NAMED assignment — targeting state (empty = untargeted legacy).
    ...(d.getDefinedVerifiers(entry.record.contributionId).length > 0
      ? { verifiers: d.getDefinedVerifiers(entry.record.contributionId) }
      : {}),
```

- [ ] **Step 3: typecheck + jest green.** Commit:

```bash
git add client/src/dao.ts client/src/stores/dao.ts
git commit -m "feat(client): reassign op + named-verifier accessor + payload plumbing"
```

---

## Task 8: wizard wiring — submit picker + reassign section

**Files:**
- Modify: `client/src/wizard/flows/contribute-flows.ts`
- Modify: `client/src/components/contribute/ContributionPage.vue`

- [ ] **Step 1: `contributeNewFlow`** — insert the members step after the dim choice (the flow factory needs the store + members — it already closes over ds):

```ts
      {
        kind: 'members', id: 'verifiers', title: 'Who verifies this?',
        // Screened at pick: non-self members the projection says may verify.
        // Reciprocity bars name their reason in the pick list's title attr.
        options: (ds.members as string[])
          .filter((m) => m && m !== ds.username)
          .filter((m) => {
            void ds.tick;
            const d = ds.dao;
            if (!d) return false;
            return !(d.node.setContains(RECIP_NAMES.verifiedBy(m), ds.username) || d.node.setContains(RECIP_NAMES.verifiedBy(ds.username), m));
          })
          .sort(),
        count: (a) => schemaForDims({ [Number(a.dim ?? '2')]: 1 }).steps.find((s) => s.op === 'verify_contribution')!.requirement.count,
      },
```

  (import RECIP_NAMES from '@shared/policies'; import schemaForDims — from '@shared/contribution'.)
  The submit wrapper passes the names:

```ts
    submit: async (a, files) => {
      const named = (a.verifiers ?? '').split(',').filter(Boolean);
      const id = await ds.submitContribution((a.summary ?? '').trim(), Number(a.dim), files?.['evidence'] ?? null, (a.evidence ?? '').trim(), named);
      ...
```

  The review step's summary gains the `Verifiers: bob, carol` line.

  ALSO the visible dead-end: if the members step's options are EMPTY, the wizard cannot proceed — the factory sets `steps`' members entry only when options exist; when the member list is exhausted, the step renders as a plain text node? SIMPLER (and honest): the step stays; its empty options render with a note. The SHELL renders an empty options list as `No eligible verifiers right now.` (one conditional in the members branch: `<p v-if="current.options.length === 0" class="muted">No eligible verifiers right now.</p>`; the step stays invalid (count>0 unmet) so the wizard blocks — visible dead-end ✓.)

- [ ] **Step 2: the reassign section on `ContributionPage.vue`** (below the appeal section; same hosting pattern):

```vue
      <div v-if="reassignAvailable" class="lc-reassign">
        <WizardFlow
          :key="'reassign'"
          :flow="reassignFlow!"
          :target-id="entry.record.contributionId"
          :initial-answers="reassignResume?.answers"
          :initial-step="reassignResume?.stepIndex"
          @close="onReassignClose"
        />
      </div>
```

```ts
// Submitter-only, verify incomplete (slots remain), targeted contribution
// (count register > 0 — an untargeted legacy flow never reassigns).
const reassignAvailable = computed(() => {
  void ds.tick;
  const e = entry.value; const d = ds.dao;
  if (!e || !d || !ds.username) return false;
  if (e.submitter !== ds.username) return false;
  if (d.getContributionStatus(e.record.contributionId) !== 'pending') return false;
  if (ds.dao?.getContributionStatus(e.record.contributionId) === 'pending' && d.getContributionAppealed(e.record.contributionId)) return false;
  const named = d.getDefinedVerifiers(e.record.contributionId);
  if (named.length === 0) return false;
  const { schema, facts } = contributionFacts(d, e);
  const verifyStep = schema.steps.find((s) => s.op === 'verify_contribution')!;
  return facts.done[verifyStep.stepId] < verifyStep.requirement.count;
});
const reassignFlow = computed(() => {
  const e = entry.value; if (!e) return null;
  return {
    id: 'reassign', title: 'Name additional verifiers',
    steps: [
      { kind: 'members' as const, id: 'verifiers', title: 'Who else verifies?',
        options: eligibleVerifierOptions(), count: remainingCount() },
      { kind: 'review' as const },
    ],
    reviewSummary: (a) => [`Adding: ${(a.verifiers ?? '').split(',').filter(Boolean).join(', ')}`],
    submit: async (a) => {
      const ok = await ds.reassignVerifiers(e.record.contributionId, (a.verifiers ?? '').split(',').filter(Boolean));
      if (!ok) throw new Error('The reassignment did not record — check the message below the page.');
    },
  } as FlowDefinition;
});
```

  (the two helpers `eligibleVerifierOptions()` / `remainingCount()` are small local functions
  built from the same reads as Step 1's screening + `requirement.count − facts.done['verify']`;
  the type assertion is acceptable; onReassignClose clears the reassign draft path — the shell
  already cleared; re-read via tick.)

- [ ] **Step 3: typecheck + jest + build:client.** Commit:

```bash
git add client/src/wizard/flows/contribute-flows.ts client/src/components/contribute/ContributionPage.vue
git commit -m "feat(contribute): verifier picker in the submit wizard + reassign section"
```

---

## Task 9: e2e — the targeted arc

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: the submit helper** drives the members step (between dim choice and summary):

```js
  // After the dim choice: the members pick. The list only offers eligible
  // verifiers; e2e users are fresh so everyone except the submitter is there.
  const needTicked = dimValue === 1 ? 2 : 1;
  await flow.locator(`.wizard-member[value="${verifierNames[0]}"]`).check();
  if (needTicked === 2) await flow.locator(`.wizard-member[value="${verifierNames[1]}"]`).check();
  await flow.locator('.wizard-next').click();
```

  — `submitContribution(submitter, dimValue, summary, verifierNames)` gains the 4th param; call
  sites pass the named users per cycle (alice names bob [+carol for C_1]).

- [ ] **Step 2: the verify drivers** — UNCHANGED mechanics (the named user runs
  `runContributionFlow(user, rowTitle, 'verify', ...)` — the named verifier is a participant,
  the row appears, the form mounts) — only the USER arguments align with the named sets.

- [ ] **Step 3: the protocol assertion** (NEW — after the targeted cycle's verify): dave (the
  unnamed member) must NOT see the contribution row (list filter) and his attention band must
  be free of the verify item:

```js
  // Protocol proof, UI leg: the UNNAMED member sees neither the row to open
  // nor a band item — the machine would reject his op anyway (jest-tested).
  const daveRowsForTarget = await dave.page.locator('.contribution-row:has-text("<targeted summary>")').count();
  if (daveRowsForTarget !== 0) throw new Error('dave sees a contribution he is not part of');
```

- [ ] **Step 4: node --check + commit (execution in Task 10):**

```bash
git add test-voting-browser.js
git commit -m "test(e2e): the targeted arc — members pick + the unnamed member's denial"
```

---

## Task 10: full verification + hand-back

**Files:** none expected.

- [ ] **Step 1:** stop the dev server (full PID chains; ports free).
- [ ] **Step 2:** `npm run build:client` → fresh `WAVEDB_PATH=/tmp/dao-4c-e2e` server → `node test-voting-browser.js` → `Smoke test passed`.
- [ ] **Step 3:** stop; `rm -rf /tmp/dao-4c-e2e`; fresh server + dev:client → `node scripts/feed-walk.mjs` → `FEED WALK PASSED`.
- [ ] **Step 4:** gates — `npm test` (15 suites green), `npm run typecheck:client` (0), `npm run build` (clean), devtools assert (only crabs.js/crabs.wasm), dialog grep 0.
- [ ] **Step 5:** restart `npm run dev` for the user (nohup + pidfile + boot line; leave running); `rm -rf /tmp/dao-4c-e2e`.

Failures: test-script bugs fixed in place; shared/store bugs → BLOCKED with output.

---

## Self-review notes (executed)

- Spec coverage: names-upfront + count-exact (Task 1), reassign op + gates + grow-only (Task 2),
  targeted verify gate + appeal-rewind survival (Task 3), feed row (Task 4), named-gate
  projection + determinate waiting + legacy fallback (Tasks 5), screened members kind +
  dead-end notice (Task 6), payload/accessor/op plumbing (Task 7), pick step + reassign section
  + review line (Task 8), targeted arc + unnamed denial (Task 9), verification (Task 10). All
  spec decisions 1-4 mapped.
- Type consistency: ReassignVerifiersPayload verbatim (Tasks 2/7); the members kind's
  `options: string[]` + fn-able count (Tasks 6/8); lifecycleModel's waitingText helper thread
  (Task 5); the e2e's 4-arg submitContribution (Task 9 call sites update).
- Known-red windows: none (Tasks 5-7 are additive; Task 8's factory/page changes keep
  typecheck green; the e2e is un-run until Task 10 by design).
- The Mock/State helper reuse follows handlers.test.ts's established classes; the reassign
  handler's requirement/done reads use the SAME HandlerState accessor surface the verify
  handler uses (`state.getRegister` / `state.getPNCounter` — both confirmed in
  node_modules/crabs-wasm/index.d.ts:260). The owner set is this slice's authentication
  upgrade; settle/appeal's payload-claim authentication is FLAGGED (owner-register gate on
  those = a small follow-up protocol slice if Victor wants it).