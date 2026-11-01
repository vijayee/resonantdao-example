# Contribution Lifecycle Wizard (Slice #4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each contribution becomes a linkable page (`/contribute/:id`) whose lifecycle wizard IS the surface — engine-native turn-taking phases (done/current/locked, waiting text, verdict banners), the slice #3 mini-flows embedded as the per-turn forms; `/contribute/new` hosts the submit wizard (dimension → summary → evidence → review); cards retire; participants-only visibility.

**Architecture:** The engine (client/src/wizard/) gains a lifecycle mode: a pure TDD'd `lifecycleModel` projection over `wizardModel` + mirror annotations, and `LifecycleWizard.vue` rendering phases + waiting states + the per-turn embedded `WizardFlow`. One new shell step kind ('evidence', file rides non-persisted filing state). The store's `submitContribution` returns the new contribution's id for the route push. Protocol representation stays in CRABS/handlers; wizardModel stays read-only; the engine renders previews only.

**Tech Stack:** Vue 3 SFC + pinia, vue-router, jest + ts-jest (pure modules), Playwright e2e.

Spec: `docs/superpowers/specs/2026-11-01-contribution-lifecycle-wizard-design.md`

---

## Conventions

- npm from repo root; commits direct to master; never stage outside the task list; SFC trailing newlines; scoped styles use design tokens only.
- jest suites in `server/test/`; `npm test` green at each task boundary (EXCEPT the noted red window in Task 7, closed by Task 8).
- Store ops follow the boolean contract pattern: guards return false (or falsy failure), `submitting.value = true` before the first await.

## Final file layout

```
Created:
  client/src/wizard/lifecycle.ts                 # pure lifecycleModel + isParticipant (TDD)
  server/test/lifecycle.test.ts                  # its jest suite (TDD)
  client/src/wizard/LifecycleWizard.vue          # engine: turn-taking phase renderer
  client/src/components/contribute/ContributionPage.vue   # /contribute/:id route
  client/src/components/contribute/NewContributionPage.vue # /contribute/new route
Deleted:
  client/src/components/contribute/ContributionCard.vue
Modified:
  client/src/wizard/types.ts                     # + 'evidence' step kind (+ optional files param)
  server/test/wizard-steps.test.ts               # evidence-kind validation tests (TDD)
  client/src/wizard/WizardFlow.vue               # evidence step rendering + files in submit
  client/src/wizard/flows/contribute-flows.ts    # + contributeNewFlow factory
  client/src/stores/dao.ts                       # submitContribution → Promise<string|null> (+ facts helper)
  client/src/components/contribute/ContributePage.vue     # slim linked list, filtered
  client/src/app/router.ts                       # two routes
  test-voting-browser.js                         # drive /contribute/new + per-page flows
```

---

## Task 1: the `evidence` step kind (TDD)

**Files:**
- Modify: `client/src/wizard/types.ts`
- Test: `server/test/wizard-steps.test.ts`

- [ ] **Step 1: extend the failing test** — add to `server/test/wizard-steps.test.ts`:

```ts
  it('evidence steps are optional (both paths empty is valid)', () => {
    // One new kind in slice #4b: the submit wizard's evidence step. BOTH
    // inputs are optional at the shell — the store's own gate
    // ('Attach evidence or give a pointer') is the authority that rejects
    // submitting with nothing, at the submit boundary.
    const evidence: FlowStep = { kind: 'evidence', id: 'evidence', title: 'Evidence', pointerPlaceholder: 'URL, commit, record id…' };
    expect(validateStep(evidence, {})).toBeNull();
    expect(validateStep(evidence, { evidence: 'https://example.com/e1' })).toBeNull();
  });
```

- [ ] **Step 2: run to FAIL** — `npx jest server/test/wizard-steps.test.ts --runInBand` → FAIL (type error: kind 'evidence' not in the union).

- [ ] **Step 3: extend `client/src/wizard/types.ts`** — add to the `FlowStep` union:

```ts
  | { kind: 'evidence'; id: string; title: string; pointerPlaceholder?: string }
```

and in `validateStep`, before the review fallthrough:

```ts
  // Evidence: optional at the shell level; the store's submit gate rejects
  // an evidence-less submission (both inputs empty) — not duplicated here.
```

(the `review` branch already returns null for any other review-like kind — evidence must have its own explicit `return null` so a future 'review' handling change doesn't silently swallow evidence; the full new function:

```ts
export function validateStep(step: FlowStep, answers: FlowAnswers): string | null {
  if (step.kind === 'choice') {
    return answers[step.id] ? null : 'Choose one to continue.';
  }
  if (step.kind === 'text') {
    return (answers[step.id] ?? '').trim() ? null : 'A written note is required.';
  }
  return null;
}
```

— evidence falls through to the final `return null`. Also extend `stepTitle` usage: evidence renders as `Review`-like steps do — the `title` field is already there, no change needed.)

- [ ] **Step 4: run to PASS** — `npx jest server/test/wizard-steps.test.ts --runInBand` → green (4 tests).

- [ ] **Step 5: commit**

```bash
git add client/src/wizard/types.ts server/test/wizard-steps.test.ts
git commit -m "feat(wizard): evidence step kind (optional at the shell; the store gate is the authority)"
```

---

## Task 2: shell evidence support + files-in-submit

**Files:**
- Modify: `client/src/wizard/WizardFlow.vue`

The shell needs three things: render the evidence step (pointer input + file input), carry File objects OUT of answers (never persisted), and hand them to the flow's submit + review summary.

- [ ] **Step 1: template** — add after the text-step branch (inside `.wizard-flow__body`):

```vue
      <div v-else-if="current.kind === 'evidence'" class="form-group">
        <legend>{{ current.title }}</legend>
        <input
          :class="['form-input', `wizard-evidence-pointer wizard-evidence-pointer--${current.id}`]"
          :aria-label="current.title"
          placeholder-style="true"
          :value="answers[currentStepId] ?? ''"
          :placeholder="current.pointerPlaceholder ?? 'Evidence pointer (URL, commit, record id)…'"
          @input="answers[currentStepId] = ($event.target as HTMLInputElement).value"
        />
        <input
          :class="['form-input', `wizard-evidence-file wizard-evidence-file--${current.id}`]"
          type="file"
          :aria-label="current.title + ' — file'"
          @change="onEvidenceFile(current.id, $event)"
        />
      </div>
```

(CORRECTION — this is HTML, not Vue: use `:placeholder="current.pointerPlaceholder ?? 'Evidence pointer (URL, commit, record id)…'"` and DROP the `placeholder-style` line entirely; `legend` inside a div is invalid — render the title as a span label. The corrected block:)

```vue
      <div v-else-if="current.kind === 'evidence'" class="form-group">
        <span class="form-label">{{ current.title }} <span class="muted">— optional</span></span>
        <input
          :class="['form-input', `wizard-evidence-pointer wizard-evidence-pointer--${current.id}`]"
          :aria-label="current.title"
          :value="answers[currentStepId] ?? ''"
          :placeholder="current.pointerPlaceholder ?? 'Evidence pointer (URL, commit, record id)…'"
          @input="answers[currentStepId] = ($event.target as HTMLInputElement).value"
        />
        <input
          :class="['form-input', `wizard-evidence-file wizard-evidence-file--${current.id}`]"
          type="file"
          :aria-label="current.title + ' — file'"
          @change="onEvidenceFile(current.id, $event)"
        />
      </div>
```

- [ ] **Step 2: script** — the filing state + wiring:

```ts
import type { FlowStep } from './types';

// Evidence files ride OUTSIDE answers: Files never serialize into drafts.
const files = ref<Record<string, File | null>>({});

function onEvidenceFile(stepId: string, ev: Event): void {
  files.value = { ...files.value, [stepId]: (ev.target as HTMLInputElement).files?.[0] ?? null };
}
```

change `props.flow.reviewSummary(committedAnswers)` in the template to `props.flow.reviewSummary(committedAnswers, filesForReview)`, and in script:

```ts
// Review summary sees the file NAMES (for 'file attached' lines) but never
// receives the File objects.
const filesForReview = computed(() =>
  Object.fromEntries(Object.entries(files.value).map(([k, f]) => [k, f ? f.name : null])));
```

change `submitNow`'s call:

```ts
    await props.flow.submit(committedAnswers.value, pickedFiles.value);
```

with

```ts
// The REAL File objects (unwrapped from ref for the submit handoff).
const pickedFiles = computed(() => files.value);
```

(the computed indirection keeps template reactivity clean; `submit` receives the record as-is.)

- [ ] **Step 3: types** — `FlowDefinition` gains the signatures:

```ts
export interface FlowDefinition {
  id: string;   // draft-key part ('verify' | 'settle' | 'appeal' | 'audit' | 'reckon' | 'publish' | 'contribute-new')
  title: string;
  steps: FlowStep[];
  reviewSummary(answers: FlowAnswers, files?: Record<string, string | null>): string[];
  submit(answers: FlowAnswers, files?: Record<string, File | null>): Promise<void>;
}
```

- [ ] **Step 4: typecheck** — existing five flow factories ignore the extra param (TS allows fewer params); the shell compiles clean.

Run: `npm run typecheck:client` → 0 errors; `npm test` → green.

- [ ] **Step 5: commit**

```bash
git add client/src/wizard/WizardFlow.vue client/src/wizard/types.ts
git commit -m "feat(wizard): shell renders evidence steps; Files ride outside drafts"
```

---

## Task 3: store — `submitContribution` returns the id + facts helper

**Files:**
- Modify: `client/src/stores/dao.ts`

- [ ] **Step 1: change the return type** — `submitContribution(summary, dim, evidenceFile, evidenceText): Promise<string | null>` — every guard continues `return false;`… CORRECTION: with a string return type, `false` is invalid — the guards become `return null;` (falsy failure preserved) and the success path returns the contribution id:

```ts
      status.set('Contribution submitted — awaiting verification.', 'success');
      bump();
      return payload.contributionId;
```

and in the catch, `return null;`.

- [ ] **Step 2: add the facts helper** (top-level export, next to `serverClient`) — the pages' per-entry fact assembly (extracted from the retired ContributionCard's computed):

```ts
import { schemaForDims } from '@shared/contribution';
import { ContributionFacts, wizardModel } from '@shared/wizard';

export function contributionFacts(entry: ContributionMirrorEntry, viewer: string): { schema: ReturnType<typeof schemaForDims>; facts: ContributionFacts } {
  const d = dao.value!;
  const status = d.getContributionStatus(entry.record.contributionId);
  const schema = schemaForDims(entry.record.dims);
  const facts: ContributionFacts = {
    status: status === 'unknown' ? -1 : status === 'accepted' ? 1 : status === 'rejected' ? 2 : 0,
    stepIndex: d.getContributionStepIndex(entry.record.contributionId),
    done: Object.fromEntries(schema.steps.map((s) => [
      s.stepId, d.getContributionStepDone(entry.record.contributionId, s.stepId),
    ])),
    submitter: entry.submitter,
  };
  return { schema, facts };
}
```

(NOTE: `contributionFacts` must live INSIDE the defineStore setup body or take `d` as a param — it reads `dao.value`. Cleanest: accept the dao as the first param: `contributionFacts(d: BrowserDao, entry, viewer?)` — the viewer param is unused by the facts assembly; drop it. Final signature:

```ts
export function contributionFacts(d: BrowserDao, entry: ContributionMirrorEntry): { schema; facts: ContributionFacts }
```

with `const { schema, facts } = contributionFacts(d, entry);` at both consuming pages.)

- [ ] **Step 3: typecheck + jest** → 0 errors / green. (Callers: ContributePage currently calls `ds.submitContribution(...)` and checks truthiness — `ok` remains falsy-on-failure so nothing breaks.)

- [ ] **Step 4: commit**

```bash
git add client/src/stores/dao.ts
git commit -m "refactor(stores): submitContribution returns the id; shared facts helper"
```

---

## Task 4: `lifecycle.ts` — pure turn-taking projection (TDD)

**Files:**
- Create: `client/src/wizard/lifecycle.ts`
- Test: `server/test/lifecycle.test.ts`

- [ ] **Step 1: write the failing test** — `server/test/lifecycle.test.ts`:

```ts
import { lifecycleModel, isParticipant, LifecycleModel } from '../../client/src/wizard/lifecycle';
import { SCHEMAS } from '../../shared/src/contribution';
import { ContributionFacts } from '../../shared/src/wizard';
import { ContributionMirrorEntry } from '../../client/src/dao';
import type { FeedEvent } from '../../shared/src/feed';

const schema = SCHEMAS.get(2)!; // C_2: submit → verify → settle (single verify)

function entry(overrides: Partial<ContributionMirrorEntry> = {}): ContributionMirrorEntry {
  return {
    record: {
      contributionId: 'c-1',
      dims: { '2': 1 },
      summary: 'Built a shelf',
      evidenceRef: { hash: 'h1', uri: 'https://example.com/e', mediaType: 'text/uri-list', size: 30 },
      schemaVersion: 'v2',
    },
    submitter: 'alice',
    submittedAt: 1000,
    ...overrides,
  } as ContributionMirrorEntry;
}
const facts = (stepIndex: number, done: Record<string, number>, status = 0): ContributionFacts =>
  ({ status, stepIndex, done, submitter: 'alice' });

function verifyEvent(actor: string, at: number): FeedEvent {
  return { index: 1, type: 'contribution_verified', actor, at, round: 1, summary: 'x', targetId: 'c-1' } as FeedEvent;
}

describe('lifecycleModel', () => {
  it('renders submitted state: submit done (who/when), verify current + waiting, settle locked', () => {
    const m = lifecycleModel(schema, facts(1, { submit: 1 }), entry(), 'bob', false, []);
    expect(m.outcome).toBe('pending');
    const [sub, ver, set] = m.phases;
    expect(sub.state).toBe('done');
    expect(sub.doneBy).toBe('alice');
    expect(sub.doneAt).toBe(1000);
    expect(ver.state).toBe('current');
    expect(ver.mayAct).toBe(true);        // bob may verify (no-self bars only alice)
    expect(ver.flow).toBeUndefined();     // flows are attached page-side, never in the pure model
    expect(set.state).toBe('locked');
  });

  it('waiting text is ROLE-based, never a member name (the domain cannot know who acts next)', () => {
    const m = lifecycleModel(schema, facts(1, { submit: 1 }), entry(), 'carol', false, []);
    expect(m.phases[1].mayAct).toBe(true);    // carol also eligible — the model says WHO MAY act, not who will
    const notMine = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry(), 'bob', false, []);
    expect(notMine.phases[2].mayAct).toBe(false);
    expect(notMine.phases[2].waitingOn).toMatch(/submitter/i);
  });

  it('verified step annotates who verified (mirror names) + when (feed event, degrading)', () => {
    const m = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry({ verifiedBy: 'bob', verifiers: ['bob'] }), 'carol', false, [verifyEvent('bob', 2000)]);
    const ver = m.phases[1];
    expect(ver.state).toBe('done');
    expect(ver.doneBy).toBe('bob');
    expect(ver.doneAt).toBe(2000);
    // Degrade: no matching event → who stays, when drops.
    const m2 = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry({ verifiedBy: 'bob', verifiers: ['bob'] }), 'carol', false, []);
    expect(m2.phases[1].doneBy).toBe('bob');
    expect(m2.phases[1].doneAt).toBeUndefined();
  });

  it('settled outcome renders the terminal banner data + allComplete', () => {
    const acc = lifecycleModel(schema, facts(3, { submit: 1, verify: 1, settle: 1 }, 1), entry({ settledBy: 'alice' }), 'bob', false, []);
    expect(acc.outcome).toBe('accepted');
    expect(acc.phases.map((p) => p.state)).toEqual(['done', 'done', 'done']);
    const rej = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }, 2), entry({ verdict: false, verdictReason: 'not findable', verifiedBy: 'bob' }), 'alice', false, []);
    expect(rej.outcome).toBe('rejected');
    expect(rej.phases[1].note).toBe('not findable');
  });

  it('unknown schema version / unknown lifecycle renders read-only phases without turn info', () => {
    const m = lifecycleModel(schema, { status: -1, stepIndex: 0, done: { submit: 1 }, submitter: 'alice' }, entry(), 'bob', false, []);
    expect(m.readOnly).toBe(true);
    expect(m.phases.every((p) => p.mayAct === false)).toBe(true);
  });

  it('all-parties partial verify shows progress and stays current', () => {
    const c1 = SCHEMAS.get(1)!;
    const m = lifecycleModel(c1, facts(1, { submit: 1, verify: 1 }), entry({ dims: { '1': 1 }, record: { contributionId: 'c-1', dims: { '1': 1 }, summary: 'x', evidenceRef: { hash: 'h', uri: 'u', mediaType: 'text/uri-list', size: 3 }, schemaVersion: 'v2' }, verifiedBy: 'bob', verifiers: ['bob'] } as Partial<ContributionMirrorEntry>), 'carol', false, []);
    expect(m.phases[1].state).toBe('current');
    expect(m.phases[1].progress).toEqual({ done: 1, required: 2 });
  });
});

describe('isParticipant', () => {
  const factsOpen = facts(1, { submit: 1 });
  it('submitter is always a participant', () => {
    expect(isParticipant(entry(), 'alice', false, schema, factsOpen)).toBe(true);
  });
  it('an eligible actor at the current step participates', () => {
    expect(isParticipant(entry(), 'bob', false, schema, factsOpen)).toBe(true);   // verifier role
    expect(isParticipant(entry(), 'carol', false, schema, factsOpen)).toBe(true); // verifiers are a class, not a fixed person
  });
  it('custodians see everything; outsiders at terminal steps stay out (already-acted keeps prior verifiers in)', () => {
    expect(isParticipant(entry(), 'dave', true, schema, factsOpen)).toBe(true);
    const settled = facts(3, { submit: 1, verify: 1, settle: 1 }, 1);
    expect(isParticipant(entry({ verifiers: ['bob'] } as Partial<ContributionMirrorEntry>), 'bob', false, schema, settled)).toBe(true);
    expect(isParticipant(entry(), 'dave', false, schema, settled)).toBe(false);
    expect(isParticipant(entry(), 'dave', false, schema, factsOpen)).toBe(true); // dave may STILL act (eligible verifier class)
  });
});
```

- [ ] **Step 2: run to FAIL** — `npx jest server/test/lifecycle.test.ts --runInBand` → FAIL (module not found).

- [ ] **Step 3: write `client/src/wizard/lifecycle.ts`** — pure over (schema, facts, entry, viewer, custodian, feedEvents); flows are NEVER attached here (page-side duty):

```ts
// Pure turn-taking projection for the contribution lifecycle page: one model
// per viewer. Protocol representation lives in the CRABS state machine
// (registers + handler rules are authoritative); this module re-derives a
// read-only view for display and can never grant a turn — eligibility always
// resolves back to registers + handler rules. Flows (the per-turn forms) are
// attached by the PAGE, never here: this stays store-free and jest-tested.
import { DimensionSchema } from './contribution';
import { ContributionFacts, StepState, WizardStep, wizardModel } from './wizard';
import type { ContributionMirrorEntry } from '../dao';
import type { FeedEvent } from '@shared/feed';

export interface LifecyclePhase {
  stepId: string;
  title: string;
  state: StepState;                       // 'complete' | 'current' | 'locked'
  doneBy?: string;
  doneAt?: number;
  progress?: { done: number; required: number };
  mayAct: boolean;
  waitingOn?: string;                     // role-based text; never a member name
  note?: string;                          // verdict/reason summary on done phases
}

export interface LifecycleModel {
  contributionId: string;
  summary: string;
  submitter: string;
  outcome: 'pending' | 'accepted' | 'rejected';
  appealed: boolean;
  readOnly: boolean;
  phases: LifecyclePhase[];
}

const WAITING_TEXT: Record<string, string> = {
  submit: 'awaiting the submission',
  verify: 'awaiting a verification',
  settle: 'awaiting the settlement',
};

function verifyAnnotations(entry: ContributionMirrorEntry, feedEvents: FeedEvent[]): { doneBy?: string; doneAt?: number; note?: string } {
  const who = entry.verifiedBy ?? entry.verifiers?.[0];
  if (!who) return {};
  const matching = feedEvents.filter((e) => e.targetId === entry.record.contributionId && e.type === 'contribution_verified';
  return { doneBy: who, doneAt: matching.length > 0 ? matching[matching.length - 1].at : undefined };
}

function phaseFor(step: WizardStep, entry: ContributionMirrorEntry, viewer: string, viewerIsCustodian: boolean, feedEvents: FeedEvent[]): LifecyclePhase {
  const mayAct = step.state === 'current'
    && Object.values(step.roles).some((r) => r?.mayAct);
  const phase: LifecyclePhase = {
    stepId: step.stepId,
    title: step.title,
    state: step.state,
    progress: { done: step.progress.done, required: step.progress.required },
    mayAct,
    waitingOn: step.state === 'current' && !mayAct ? WAITING_TEXT[step.stepId] : undefined,
    note: step.stepId === 'verify' && entry.verdictReason ? entry.verdictReason : undefined,
  };
  if (step.state === 'complete') {
    if (step.stepId === 'submit') {
      phase.doneBy = entry.submitter;
      phase.doneAt = entry.submittedAt;
    } else if (step.stepId === 'verify') {
      const ann = verifyAnnotations(entry, feedEvents);
      phase.doneBy = ann.doneBy;
      phase.doneAt = ann.doneAt;
    } else if (step.stepId === 'settle') {
      phase.doneBy = entry.settledBy;
    }
  }
  void viewer;
  void viewerIsCustodian;
  return phase;
}

export function lifecycleModel(
  schema: DimensionSchema,
  facts: ContributionFacts,
  entry: ContributionMirrorEntry,
  viewer: string,
  viewerIsCustodian: boolean,
  feedEvents: FeedEvent[] = [],
): LifecycleModel {
  const wm = wizardModel(schema, facts, viewer, viewerIsCustodian);
  return {
    contributionId: entry.record.contributionId,
    summary: entry.record.summary,
    submitter: entry.submitter,
    outcome: wm.outcome,
    appealed: wm.appealed ?? false,
    readOnly: wm.readOnly,
    phases: wm.steps.map((s) => phaseFor(s, entry, viewer, viewerIsCustodian, feedEvents)),
  };
}

// Page-level guard (spec decision 4): participants = submitter + anyone with
// an actionable role at the current step + anyone who already acted
// (verifiers/settled/appealed) + custodians. UI-level only: replica bytes
// remain members-visible; enforcement stays in the handlers.
export function isParticipant(
  entry: ContributionMirrorEntry,
  viewer: string,
  viewerIsCustodian: boolean,
  schema: DimensionSchema,
  facts: ContributionFacts,
): boolean {
  if (viewer === entry.submitter) return true;
  if (entry.submitter === undefined) return false;
  const acted = entry.verifiedBy === viewer
    || (entry.verifiers ?? []).includes(viewer)
    || entry.settledBy === viewer
    || entry.appealedBy === viewer;
  if (acted) return true;
  if (viewerIsCustodian) return true;
  const wm = wizardModel(schema, facts, viewer, viewerIsCustodian);
  const current = wm.steps[wm.currentStepIndex];
  if (!current) return false;                    // terminal/read-only: actors stay in
  return Object.values(current.roles).some((r) => r?.mayAct);
}
```

(CORRECTIONS to apply as written: (1) fix the syntax error — the filter line must be
`... && e.type === 'contribution_verified');`; (2) the `void viewer; void viewerIsCustodian;`
lines are unnecessary — viewer/custodian are used via wizardModel's roles; delete them;
(3) `entry.submitter === undefined` guard is meaningless (entry.submitter is always set) — delete;
(4) isParticipant's terminal-step semantics: wizardModel for terminal (status 1/2) renders steps
'complete' with actionable FALSE and currentStepIndex -1 → `current` undefined → the function
returns false for non-acted/custodian viewers ✓ (the test's last line relies on the OPEN state
returning true for carol — verify the trace: factsOpen has verify current + carol eligible →
true ✓).)

- [ ] **Step 4: run to PASS** — `npx jest server/test/lifecycle.test.ts --runInBand` → green (10 tests).

- [ ] **Step 5: full jest + commit**

Run: `npm test` → green.

```bash
git add client/src/wizard/lifecycle.ts server/test/lifecycle.test.ts
git commit -m "feat(wizard): pure turn-taking lifecycle projection (TDD)"
```

---

## Task 5: `LifecycleWizard.vue` — the engine's turn-taking renderer

**Files:**
- Create: `client/src/wizard/LifecycleWizard.vue`

- [ ] **Step 1: write the SFC:**

```vue
<template>
  <div class="lc-wizard" role="region" :aria-label="'Contribution flow — ' + model.summary">
    <div class="lc-wizard__head">
      <strong>{{ model.summary }}</strong>
      <span :class="['lc-pill', `lc-pill--${model.appealed ? 'appealed' : model.outcome}`]">
        {{ model.appealed ? 'appealed' : model.outcome }}
      </span>
    </div>
    <div class="muted lc-wizard__meta">by {{ model.submitter }}</div>

    <p v-if="model.readOnly" id="lc-readonly" class="muted">
      This contribution's schema version isn't recognized — rendering read-only.
    </p>

    <div v-else class="lc-wizard__phases">
      <div
        v-for="(phase, i) in model.phases"
        :key="phase.stepId"
        :class="['lc-phase', `lc-phase--${phase.state}`]"
      >
        <div class="lc-phase__head">
          <span class="lc-phase__dot">{{ phase.state === 'done' ? '✓' : phase.state === 'current' ? '●' : '○' }}</span>
          <span class="lc-phase__title">{{ i + 1 }}. {{ phase.title }}</span>
          <span v-if="phase.progress && phase.state === 'current'" class="lc-phase__progress mono">{{ phase.progress.done }}/{{ phase.progress.required }}</span>
          <span v-if="phase.state === 'done' && phase.doneBy" class="muted lc-phase__done">— {{ phase.doneBy }}<template v-if="phase.doneAt">, {{ clock(phase.doneAt) }}</template></span>
        </div>
        <div v-if="phase.note" class="muted lc-phase__note">{{ phase.note }}</div>
        <div v-if="phase.state === 'current' && phase.mayAct && pageFlow" class="lc-phase__form">
          <WizardFlow
            :key="phaseKey"
            :flow="pageFlow"
            :target-id="model.contributionId"
            :initial-answers="resume?.answers"
            :initial-step="resume?.stepIndex"
            @close="emit('flow-close')"
          />
        </div>
        <div v-else-if="phase.state === 'current' && !phase.mayAct" class="muted lc-phase__wait">{{ phase.waitingOn }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import WizardFlow from './WizardFlow.vue';
import type { WizardDraft } from './drafts';
import type { FlowDefinition } from './types';
import type { LifecycleModel, LifecyclePhase } from './lifecycle';

const props = defineProps<{
  model: LifecycleModel;
  pageFlow: FlowDefinition | null;    // the current phase's form, attached by the page
  resume: WizardDraft | null;          // the page flow's draft (page reads it)
}>();
const emit = defineEmits<{ 'flow-close': [] }>();

// The embedded flow's key INCLUDES the phase id: a facts-driven phase change
// remounts cleanly (stale-initial insurance, slice #3 rule).
const phaseKey = computed(() => `${props.pageFlow?.id ?? 'none'}/${props.model.contributionId}`);

function clock(atMs: number): string {
  return new Date(atMs).toTimeString().slice(0, 5);
}
</script>

<style scoped>
.lc-wizard { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-4); background: var(--glass); display: flex; flex-direction: column; gap: var(--space-2); }
.lc-wizard__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.lc-pill { font-family: var(--font-mono); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .15rem var(--space-2); border-radius: 999px; }
.lc-pill--pending { color: var(--muted); border: 1px solid var(--line); }
.lc-pill--accepted { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.lc-pill--rejected { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
.lc-pill--appealed { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
.lc-wizard__phases { display: flex; flex-direction: column; gap: var(--space-2); }
.lc-phase { display: flex; flex-direction: column; gap: var(--space-1); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3); }
.lc-phase--locked { opacity: .6; }
.lc-phase--done .lc-phase__dot { color: var(--jade); }
.lc-phase--current { border-color: var(--jade); }
.lc-phase__head { display: flex; align-items: baseline; gap: var(--space-2); }
.lc-phase__title { font-size: .9375rem; }
.lc-phase__progress { color: var(--jade); }
.lc-phase__wait { font-size: .8125rem; }
</style>
```

(Import note: `computed` must join the vue import; the appeal section is the PAGE's concern,
not this component's — the page renders its own appeal affordance per the spec.)

- [ ] **Step 2: typecheck** — `npm run typecheck:client` → 0 errors (this task's file only; known-red window opens in Tasks 6-7 — do NOT fix those).

Wait — with this file self-contained (only types + drafts imports), NO red window opens here: Task 5's typecheck is clean at its own commit.

- [ ] **Step 3: commit**

```bash
git add client/src/wizard/LifecycleWizard.vue
git commit -m "feat(wizard): LifecycleWizard — turn-taking phase renderer"
```

---

## Task 6: `ContributionPage.vue` + routes (opens the known-red window)

**Files:**
- Create: `client/src/components/contribute/ContributionPage.vue`
- Modify: `client/src/app/router.ts`

- [ ] **Step 1: write `ContributionPage.vue`:**

```vue
<template>
  <div v-if="denial" class="lc-denial muted">{{ denial }}</div>
  <template v-else-if="entry">
    <SectionHeading number="03" eyebrow="Contribution" title="The flow">
      <template #lede>One flow for this contribution — submission, verification, settlement.
        Whoever's turn it is acts here.</template>
    </SectionHeading>

    <Panel number="01" kicker="Lifecycle">
      <LifecycleWizard
        :model="model"
        :page-flow="pageFlow"
        :resume="resume"
        @flow-close="onFlowClose"
      />
      <div v-if="!model.appealed && model.outcome === 'rejected' && entry.submitter === ds.username" class="lc-appeal">
        <WizardFlow
          :key="'appeal'
          :flow="appealFlow"
          :target-id="entry.record.contributionId"
          :initial-answers="appealResume?.answers"
          :initial-step="appealResume?.stepIndex"
          @close="onAppealClose"
        />
      </div>
    </Panel>

    <Panel number="02" kicker="Evidence">
      <button
        v-if="evidenceRef.uri.startsWith('content://') && !evidenceImgUrl && !evidenceDlUrl"
        type="button"
        class="button button--secondary evidence-load"
        :disabled="ds.submitting"
        @click="loadEvidence"
      >Load evidence</button>
      <img v-if="evidenceImgUrl" alt="contribution evidence" :src="evidenceImgUrl" class="evidence-img" />
      <a v-else-if="evidenceDlUrl" class="evidence-dl" :href="evidenceDlUrl" :download="`evidence-${entry.record.contributionId.slice(0, 8)}`">Download evidence ({{ evidenceRef.mediaType }})</a>
      <span v-else class="muted">{{ evidenceLabel }}</span>
    </Panel>
  </template>
  <div v-else class="lc-denial muted">Unknown contribution.</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { harmFactorFor, paymentFor } from '@shared/contribution';
import { useDaoStore } from '../../stores/dao';
import { appealFlow, settleFlow, verifyFlow } from '../../wizard/flows/contribute-flows';
import { isParticipant } from '../../wizard/lifecycle';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import type { FlowDefinition } from '../../wizard/types';
import LifecycleWizard from '../../wizard/LifecycleWizard.vue';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const route = useRoute();
const contributionId = String(route.params.contributionId);

const located = computed(() => {
  void ds.tick;
  const d = ds.dao;
  return d ? d.getContributions().find((e) => e.record.contributionId === contributionId) : undefined;
});

const composed = computed(() => {
  void ds.tick;
  const entry = located.value;
  if (!entry || !ds.dao || !ds.username) return null;
  const { schema, facts } = contributionFacts(ds.dao, entry);
  const model = lifecycleModel(schema, facts, entry, ds.username, (ds.custodians ?? []).includes(ds.username), ds.feedEvents());
  // Attach the CURRENT phase's form (page-side duty; never in the pure model).
  const current = model.phases.find((p) => p.state === 'current' && p.mayAct);
  const FACTORIES: Record<string, (e: typeof entry) => FlowDefinition> = {
    verify: verifyFlow, settle: settleFlow, appeal: appealFlow,
  };
  return {
    entry,
    model,
    schema,
    facts,
    pageFlow: current ? (FACTORIES[current.stepId]?.(entry) ?? null) : null,
    resume: current ? loadDraft(localStorage, ds.username, current.stepId, entry.record.contributionId) : null,
  };
});

const entry = computed(() => composed.value?.entry ?? located.value);
const model = computed(() => composed.value!.model);
const pageFlow = computed(() => composed.value!.pageFlow);
const resume = computed(() => composed.value!.resume);

const appealFlow = computed(() => (entry.value ? appealFlow(entry.value) : null));
const appealResume = computed(() => (ds.username && entry.value ? loadDraft(localStorage, ds.username, 'appeal', entry.value.record.contributionId) : null));
function onAppealClose() {
  // tick gating re-derives the outcome; nothing to clear.
}
function onFlowClose() {
  // The flow's phase advances (or fails legibly); tick re-derives everything.
}

// Participants-only (spec decision 4). The denial branch never mounts the
// wizard — replica bytes remain the honest caveat documented in the spec.
const denial = computed(() => {
  void ds.tick;
  const e = located.value;
  if (!ds.dao || !ds.username) return 'Loading…';
  if (!e) return 'Unknown contribution.';
  const { schema, facts } = contributionFacts(ds.dao, e);
  return isParticipant(e, ds.username, (ds.custodians ?? []).includes(ds.username), schema, facts)
    ? null
    : "You're not part of this contribution.";
});

// Evidence display (moved verbatim from the retired ContributionCard):
const evidenceRef = computed(() => entry.value?.record.evidenceRef ?? { hash: '', uri: '', mediaType: '', size: 0 });
const evidenceImgUrl = ref<string | null>(null);
const evidenceDlUrl = ref<string | null>(null);
const evidenceFailed = ref(false);
const evidenceLabel = computed(() => {
  if (evidenceFailed.value) return 'evidence unavailable';
  return evidenceRef.value.uri.startsWith('content://')
    ? `stored evidence (${(evidenceRef.value.size / 1024).toFixed(1)} KB, ${evidenceRef.value.mediaType})`
    : `pointer: ${evidenceRef.value.uri}`;
});
const ownedUrls: string[] = [];
onBeforeUnmount(() => { for (const url of ownedUrls) URL.revokeObjectURL(url); });

async function loadEvidence() {
  const r = evidenceRef.value;
  const hash = r.uri.slice('content://'.length);
  try {
    const content = await serverClient.getContent(hash);
    if (!content) throw new Error('evidence unavailable');
    const blob = new Blob([content.bytes as BlobPart], { type: content.mediaType });
    const url = URL.createObjectURL(blob);
    ownedUrls.push(url);
    if (content.mediaType.startsWith('image/')) evidenceImgUrl.value = url;
    else evidenceDlUrl.value = url;
  } catch (err) {
    void err;
    evidenceFailed.value = true;
  }
}
</script>

<style scoped>
.lc-denial { padding: var(--space-6); text-align: center; }
.lc-appeal { margin-top: var(--space-3); }
.evidence-img { max-width: 100%; border-radius: var(--radius); }
.evidence-dl { color: var(--jade); font-family: var(--font-mono); font-size: .8125rem; }
</style>
```

(KNOWN GAPS TO FIX WHILE IMPLEMENTING — these are the deliberate strictness gaps: (1) `serverClient`
and `ref` imports missing above — add `import { ref } from 'vue';` and
`import { serverClient } from '../../stores/dao';` (serverClient is exported next to the store);
(2) the `:key="'appeal'` line is missing its closing quote/attribute — write it as a full
`:key="'appeal'"`; (3) `contributionFacts` + `lifecycleModel` imports:
`import { contributionFacts } from '../../stores/dao';` and
`import { lifecycleModel } from '../../wizard/lifecycle';`; (4) the appeal WizardFlow's `close`
handler name mismatch (`onAppealClose` does nothing — it MUST clear the appeal draft path? No:
the shell already clears/closes; the page's handler exists since an emitted event with no
listener is a Vue warning) — keep the empty handler with a one-line comment;
(5) `harmFactorFor/paymentFor` are used by the harm receipt — ADD the harm receipt display to
this page (moved from the card, code below) or drop the import; the spec lists the harm
receipt as page display — ADD:

```ts
const harmReceipt = computed(() => {
  void ds.tick;
  const e = entry.value;
  if (!e || ds.dao?.getContributionStatus(e.record.contributionId) !== 'accepted' || !e.harm || e.harm === 'none') return null;
  if (e.harm === 'voided') return 'accepted — outcome voided (harm)';
  const base = Object.entries(e.record.dims).reduce((sum, [dimKey, match]) => sum + paymentFor(Number(dimKey), match), 0);
  const factor = harmFactorFor(e.harm);
  const label = Object.keys(e.record.dims).includes('1') ? 'bounty' : 'credit';
  const fmt = (n: number) => String(Number(n.toFixed(6)));
  return `accepted — ${label} ${fmt(base)} → ${fmt(base * factor)} (harm reduced)`;
});
```
plus template line in the Lifecycle panel:
`<div v-if="harmReceipt" class="lc-harm">{{ harmReceipt }}</div>` styled
`.lc-harm { color: var(--amber); font-size: .8125rem; }`.)

- [ ] **Step 2: routes** — in `client/src/app/router.ts`, replace the contribute route with THREE:

```ts
    { path: '/contribute', name: 'contribute', component: () => import('../components/contribute/ContributePage.vue') },
    { path: '/contribute/new', name: 'contribute-new', component: () => import('../components/contribute/NewContributionPage.vue') },
    { path: '/contribute/:contributionId', name: 'contribution', component: () => import('../components/contribute/ContributionPage.vue') },
```

(vue-router matches the static `/contribute/new` before the param route — no ordering trap, but
the `new` route MUST be declared; note NewContributionPage arrives in Task 7 — until then
typecheck is red ONLY if the router lazy import target doesn't exist at build time. The known-red
window: Tasks 6+7 land before the typecheck gate; do not fix ContributePage inside this task.)

- [ ] **Step 3: no commit yet (Task 7 closes the window).**

---

## Task 7: `NewContributionPage.vue` + `contributeNewFlow` + ContributePage list rewrite

**Files:**
- Create: `client/src/components/contribute/NewContributionPage.vue`
- Modify: `client/src/wizard/flows/contribute-flows.ts`
- Modify: `client/src/components/contribute/ContributePage.vue`
- Delete: `client/src/components/contribute/ContributionCard.vue`

- [ ] **Step 1: the flow factory** (append to `contribute-flows.ts`):

```ts
// The new-contribution wizard: linear flow at /contribute/new. The submit
// success routes to the new lifecycle page — the page supplies onSubmitted
// (the store returns the id; routing is the page's business, never the
// factory's).
export function contributeNewFlow(onSubmitted: (contributionId: string) => void): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'contribute-new',
    title: 'New contribution',
    steps: [
      {
        kind: 'choice', id: 'dim', title: 'What kind of contribution?',
        options: [
          { value: '2', label: 'C_2 Recording', desc: 'a durable, findable record — base credit 3 $RES' },
          { value: '1', label: 'C_1 Building', desc: 'built something real — bounty 12 $RES' },
        ],
      },
      { kind: 'text', id: 'summary', title: 'Describe it', placeholder: 'What did you make or record?' },
      { kind: 'evidence', id: 'evidence', title: 'Evidence', pointerPlaceholder: 'URL, commit, record id…' },
      { kind: 'review' },
    ],
    reviewSummary: (a, files) => [
      `Type: ${a.dim}`,
      `Summary: ${(a.summary ?? '').trim()}`,
      files?.['evidence'] ? 'Evidence: stored file' : a.evidence ? `Pointer: ${a.evidence}` : 'No evidence yet',
    ],
    submit: async (a, files) => {
      const id = await ds.submitContribution((a.summary ?? '').trim(), Number(a.dim), files?.['evidence'] ?? null, (a.evidence ?? '').trim());
      if (!id) throw new Error('The contribution did not record — check the message below the page.');
      onSubmitted(id);
    },
  };
}
```

(The dim choice's option values are the DIMENSION indexes as strings; the labels/descs mirror
today's form copy. If `DIMENSIONS` gains implemented dims later, a task extends the options —
today's form had exactly C_1/C_2.)

- [ ] **Step 2: `NewContributionPage.vue`:**

```vue
<template>
  <SectionHeading number="03" eyebrow="Contribute" title="New contribution">
    <template #lede>Walk the steps — the flow's later phases open here once the contribution
      is in.</template>
  </Section_heading>

  <Panel number="01" kicker="Walk the steps">
    <WizardFlow
      :key="draftKey"
      :flow="flow"
      target-id="new"
      :initial-answers="resume?.answers"
      :initial-step="resume?.stepIndex"
      @close="onClosed"
    />
  </Panel>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { useDaoStore } from '../../stores/dao';
import { contributeNewFlow } from '../../wizard/flows/contribute-flows';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import WizardFlow from '../../wizard/WizardFlow.vue';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const auth = useAuthStore();
const router = useRouter();

// Draft rules as everywhere: the browser profile IS the key, so the
// username comes from the auth store's persisted login bundle path — read
// the username AFTER auth resolves.
const draftUsername = ref<string | null>(null);
const resume = ref<WizardDraft | null>(null);
const draftKey = ref(0);

const flow = contributeNewFlow((id) => {
  // Submit succeeded: the draft is already cleared by the shell; land on the
  // new lifecycle page.
  void router.push(`/contribute/${id}`);
});

onMounted(() => {
  const user = ds.username || null;
  draftUsername.value = user;
  if (user) resume.value = loadDraft(localStorage, user, 'contribute-new', 'new');
});

function onClosed() {
  // Cancel: the shell cleared the draft; remount fresh.
  draftKey.value += 1;
}
</script>
```

(Fix while implementing: `</Section_heading>` typo → `</SectionHeading>`; the `auth` import is
UNUSED if ds.username is enough — DELETE the unused import; `draftUsername` is unused after
reading — simplify to just `resume` + `draftKey`.)

- [ ] **Step 3: ContributePage rewrite** — the list page:

```vue
<template>
  <SectionHeading number="03" eyebrow="Contribute" title="Work, witnessed">
    <template #lede>Contributions are flows — open one to act on it, or start a new one below.</template>
  </SectionHeading>

  <Panel number="01" kicker="New contribution">
    <button id="new-contribution-btn" class="button button--primary" type="button" @click="router.push('/contribute/new')">Start a new contribution…</button>
  </Panel>

  <section id="contributions-list" aria-live="polite">
    <p v-if="visibleEntries.length === 0" class="muted">No contributions involve you yet — start one above.</p>
    <RouterLink
      v-for="entry in visibleEntries"
      :key="entry.record.contributionId"
      :to="`/contribute/${entry.record.contributionId}`"
      class="contribution-row"
    >
      <span class="contribution-row__title">{{ entry.record.summary }}</span>
      <span class="contribution-row__dim mono">{{ dimLabels(entry) }}</span>
      <span :class="['contribution-pill', `contribution-pill--${statusFor(entry)}`]">{{ statusFor(entry) }}</span>
      <span class="muted contribution-row__evidence">{{ evidenceLabel(entry) }}</span>
      <span class="contribution-row__arrow">→</span>
    </RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { useDaoStore, contributionFacts } from '../../stores/dao';
import { isParticipant } from '../../wizard/lifecycle';
import { DIMENSIONS } from '@shared/contribution';
import { listDrafts, cleanStaleDrafts } from '../../wizard/drafts';
import { onMounted } from 'vue';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const router = useRouter();

const entries = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getContributions() ?? [])].reverse();
});

// Participants-only list (spec decision 4): the viewer's own submissions,
// contributions an actionable role reaches, and (as custodian) everything.
const visibleEntries = computed(() => {
  void ds.tick;
  const d = ds.dao;
  if (!d || !ds.username) return [];
  const isCust = (ds.custodians ?? []).includes(ds.username);
  return entries.value.filter((e) => {
    const { schema, facts } = contributionFacts(d, e);
    return isParticipant(e, ds.username, isCust, schema, facts);
  });
});

function statusFor(entry) { void ds.tick; return ds.dao?.getContributionStatus(entry.record.contributionId) ?? 'unknown'; }
function dimLabels(entry) {
  void ds.tick;
  return Object.keys(entry.record.dims).map((k) => `C_${k} ${DIMENSIONS[Number(k)]?.name ?? '?'}`).join(', ');
}
function evidenceLabel(entry) {
  const uri = entry.record.evidenceRef.uri;
  return uri.startsWith('content://') ? 'stored evidence' : `pointer: ${uri}`;
}

// Draft sweep: verify/settle/appeal drafts for vanished targets (kept from
// slice #3; the pages read their own drafts).
const flowIds = ['verify', 'settle', 'appeal'] as const;
function sweepStaleDrafts() {
  void ds.tick;
  if (!ds.usernme || !ds.dao) return;
  const ids = new Set(ds.dao.getContributions().map((e) => e.record.contributionId));
  if (ids.size === 0) return;
  for (const fid of flowIds) cleanStaleDrafts(localStorage, ds.username, fid, ids);
}
onMounted(sweepStaleDrafts);
</script>

<style scoped>
.contribution-row {
  display: flex; align-items: baseline; gap: var(--space-3);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); background: var(--glass);
  transition: border-color .2s, transform .2s;
}
.contribution-row:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.contribution-row__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9375rem; }
.contribution-row__dim { color: var(--faint); font-size: .75rem; flex: 0 0 auto; }
.contribution-row__evidence { font-size: .78rem; flex: 0 0 auto; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contribution-row__arrow { color: var(--jade); flex: 0 0 auto; }
#contributions-list { display: flex; flex-direction: column; gap: var(--space-2); }
</style>
```

(KNOWN GAPS TO FIX WHILE IMPLEMENTING: (1) `ds.usernme` typo → `ds.username`;
(2) `statusFor(entry)`/`dimLabels(entry)` untyped params — type them
`(entry: ContributionMirrorEntry)` with the dao import; (3) consolidate the two vue imports into
one line: `import { computed, onMounted } from 'vue';`; (4) the list no longer uses
`listDrafts`/activeFlow machinery — DELETE the import if unused (the sweep still needs
cleanStaleDrafts); (5) the `RouterLink` import for the template; (6) the status pill classes
(`contribution-pill--*`) — define them verbatim from the retired card's styles.)

- [ ] **Step 4: DELETE `client/src/components/contribute/ContributionCard.vue`** — grep first:
`grep -rn "ContributionCard" client/src` → must return nothing AFTER the ContributePage rewrite lands.

- [ ] **Step 5: typecheck + jest gates (the known-red window closes)**

Run: `npm run typecheck:client` → 0 errors; `npm test` → 14 suites green.

- [ ] **Step 6: commit**

```bash
git add client/src/components/contribute client/src/wizard/flows/contribute-flows.ts
git commit -m "feat(contribute): lifecycle pages + submit wizard; cards retire"
```

---

## Task 8: e2e — drive the pages

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: `submitContribution` helper** — drive `/contribute/new`:

```js
// Walk /contribute/new's wizard; returns the id parsed from the URL the
// route push lands on.
async function submitContribution(submitter, dimValue, summary) {
  await submitter.page.click('header nav a[href="/contribute"]');
  await submitter.page.click('#new-contribution-btn');
  const flow = submitter.page.locator('.wizard-flow[data-flow-id="contribute-new"]');
  await flow.waitFor({ state: 'visible', timeout: 10000 });
  await flow.locator(`.wizard-option[value="${dimValue}"]`).check();
  await flow.locator('.wizard-next').click();
  await flow.locator('textarea').fill(summary);
  await flow.locator('.wizard-next').click();
  await flow.locator('.wizard-evidence-pointer').fill('https://example.com/evidence/e2e');
  await flow.locator('.wizard-next').click();
  await flow.locator('.wizard-submit').click();
  await submitter.page.waitForURL(/\/contribute\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const url = submitter.page.url();
  const id = url.split('/contribute/')[1];
  console.log('Submitted contribution via wizard flow:', summary, id);
  return { page: submitter.page, id };
}
```

- [ ] **Step 2: per-page flow driving** — verify/settle/appeal now run on `/contribute/:id`:

```js
// Drive a flow on a contribution's lifecycle page: nav to the page (the rows
// link or direct URL), the current turn's form is mounted when it's your
// turn.
async function runContributionFlow(user, contributionId, flowId, { choiceValue = null, textValue = '' } = {}) {
  const url = `http://localhost:9000/contribute/${contributionId}`;
  await nav(user.page, '/contribute');
  await user.page.locator(`.contribution-row:has-text("${...}")`).click().catch(() => {});
  // robust: navigate directly by URL is FORBIDDEN (page.goto drops wallet
  // state) — click the row link scoped by title; fall back to the router
  // push via the band? Keep: the caller passes the row TITLE.
}
```

CORRECTION — SPA constraint: never `page.goto`; navigation MUST click the row link. The helper
takes a `rowTitle` (the summary text) and clicks that row; the flow then drives via the established
`completeFlow` with the page-scoped flow locator. Full helper (replaces any card-scoped driving):

```js
async function runContributionFlow(user, rowTitle, flowId, { choiceValue = null, textValue = '' } = {}) {
  await nav(user.page, '/contribute');
  const row = user.page.locator(`.contribution-row:has-text("${rowTitle}")`);
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await row.click();
  await completeFlow(user.page, flowId, { choiceValue, textValue });
}
```

- [ ] **Step 3: rewrite the cycle call sites** (`runWizardCycle`, `runTwoVerifierCycle`,
`runAppealFlow`) — the card-scoped `clickInCard` + `.contribution-card` selectors are GONE
(ContributionCard is deleted). The verify cycle shape: submitter submits (returns {page, id} —
the submitter is ALREADY on the new page), verifier navigates via its row (`runContributionFlow(verifier, summary, 'verify', {choiceValue: 'yes', textValue: verifyReason})`),
settle waits on the pill... CAREFUL: the pill now lives on the contribution page — the settle
driver navs to the ROW (rowTitle = summary) and after submit asserts the pill via the page:

```js
  const pill = submitter.page.locator('.lc-pill--accepted');
  settled = await pill.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
```

The (1/2) progress chip assert (runTwoVerifierCycle) moves to the page's phase rail:
`.lc-phase__progress:text-is("1/2")`; the 'Verify (2nd)' label assert: the verify flow's title on
the page (`WizardFlow` head shows `Verify — "<summary>"`); the harm receipt assert:
`.lc-harm` text contains '(harm reduced)'.

- [ ] **Step 4: `clickInCard` deleted** — grep `clickInCard|contribution-card` → 0; any caller
left converts to the page helper.

- [ ] **Step 5: syntax check + commit (execution lands in Task 9)**

Run: `node --check test-voting-browser.js` → clean.

```bash
git add test-voting-browser.js
git commit -m "test(e2e): drive /contribute/new + the lifecycle pages; cards gone"
```

---

## Task 9: full verification + dev server hand-back

**Files:** none expected.

- [ ] **Step 1: stop the dev server** (PID chain per /tmp/dao-dev.pid; full chains by PID; ports free).
- [ ] **Step 2: main e2e** — `npm run build:client` → `WAVEDB_PATH=/tmp/dao-4b-e2e npm run dev:server` (background, wait for the listen line) → `node test-voting-browser.js` → `Smoke test passed`.
- [ ] **Step 3: feed walk** — stop step-2 server; `rm -rf /tmp/dao-4b-e2e`; fresh server + `npm run dev:client` → `node scripts/feed-walk.mjs` → `FEED WALK PASSED`.
- [ ] **Step 4: gates** — `npm test` (14 suites green), `npm run typecheck:client` (0), `npm run build` (clean), `ls client/dist/wasm/crabs/` → only crabs.js crabs.wasm.
- [ ] **Step 5: dialog grep gate** — `grep -rn "prompt(\|confirm(\|alert(" client/src --include="*.vue" --include="*.ts" | wc -l` → 0.
- [ ] **Step 6: restart `npm run dev` for the user** (`nohup … >/tmp/dao-dev.log 2>&1 & echo $! >/tmp/dao-dev.pid`; both ports; boot line; leave running); `rm -rf /tmp/dao-4b-e2e`.

Failures: test-script bugs → fix in place (keep assertion strength); client-src bugs → BLOCKED with output.

---

## Self-review notes (executed)

- Spec coverage: evidence kind + files-outside-drafts (Tasks 1-2), submit wizard → id route push
  (Tasks 3, 7), lifecycleModel + isParticipant pure+TDD (Task 4), LifecycleWizard turn renderer
  (Task 5), lifecycle page + routes + denial + evidence loader + appeal + harm receipt (Task 6),
  list rewrite + card deletion + sweep (Task 7), e2e page-driving (Task 8), verification +
  hand-back (Task 9). Participant rule, route names, waiting-text rule, draft rules, evidence
  optionality all map to spec decisions 1-5 ✓.
- Type consistency: `FlowDefinition.submit(answers, files?)` — factories (Task 5/7 use files;
  the five existing factories ignore the second param — TS-legal) ✓; LifecyclePhase fields match
  LifecycleWizard's template reads (progress/waitingOn/note/doneBy/doneAt) ✓; `contributeNewFlow(onSubmitted)` matches NewContributionPage's construction ✓; runContributionFlow(user, rowTitle, flowId, opts) matches the converted call sites ✓.
- Known-red window: only Tasks 6→7 (router references NewContributionPage before it exists).
  Task 5's typecheck is self-contained green; Task 7 closes the window.
- Known plan-code traps (marked CORRECTION inline): the evidence template draft, the
  NewContributionPage typos, the ContributionPage import gaps, the settled-pill selector move —
  all fixed in-place by the implementing task per the KNOWN GAPS notes; reviewers check them.