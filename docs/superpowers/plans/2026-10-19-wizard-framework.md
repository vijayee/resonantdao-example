# Wizard Framework (Slice #3) + Settlement-Spine Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 7 browser dialogs in the settlement spine with declarative in-place wizard flows (verify, settle, appeal on Contribute; audit, reckon on Round), built on a generic reusable wizard shell with localStorage draft persistence, as the first consumers of the slice #3 wizard framework.

**Architecture:** Pure flow definitions (TS data: choice/text/review steps) + one generic `WizardFlow.vue` shell owning the progress rail, step validation, draft persistence, and submit. The five store actions lose their `prompt()`/`confirm()` calls and take typed params; guards stay in the store. Host pages mount the shell in place of the entry button, one flow at a time, with "resume draft" affordances. e2e drives the wizards directly (the dialog-answering contract dies).

**Tech Stack:** Vue 3 SFC + pinia (slices #1/#2 conventions), jest + ts-jest for the pure modules, Playwright e2e.

Spec: `docs/superpowers/specs/2026-10-19-wizard-framework-design.md`

---

## Conventions (apply throughout)

- All npm commands from the repo root. Commits go directly to master.
- Never stage files outside your task's list; tree clean at each commit.
- Scoped styles reference design tokens only; SFCs end with a trailing newline.
- The status store keeps working for guard rejections + op outcomes; the shell adds an inline error panel only for submit failures.
- jest suites live in `server/test/` (they happily cover dependency-free client modules); `npm test` must stay green at each task boundary.

## Final file layout

```
Created:
  client/src/wizard/drafts.ts               # localStorage draft store (injectable Storage)
  server/test/wizard-drafts.test.ts         # jest tests for the draft store (TDD)
  client/src/wizard/types.ts                # FlowStep/FlowDefinition + stepTitle/validateStep (TDD)
  server/test/wizard-steps.test.ts          # jest tests for validateStep (TDD)
  client/src/wizard/WizardFlow.vue          # generic shell
  client/src/wizard/flows/contribute-flows.ts   # verify/settle/appeal factories
  client/src/wizard/flows/round-flows.ts        # audit/reckon factories
Modified:
  client/src/stores/dao.ts                  # 5 actions lose dialogs, take typed params
  client/src/components/contribute/ContributionCard.vue   # in-place hosting + resume
  client/src/components/contribute/ContributePage.vue     # page-level one-at-a-time + draft badges
  client/src/components/round/RoundPage.vue               # audit/reckon flows in place
  test-voting-browser.js                    # armDialogs → direct wizard driving
  scripts/feed-walk.mjs                     # audit prompt handling → wizard clicks
Deleted:
  (nothing)
```

---

## Task 1: draft store (TDD)

**Files:**
- Create: `client/src/wizard/drafts.ts`
- Test: `server/test/wizard-drafts.test.ts`

- [ ] **Step 1: write the failing test** — `server/test/wizard-drafts.test.ts`:

```ts
import { loadDraft, saveDraft, clearDraft, listDrafts, cleanStaleDrafts, WizardDraft } from '../../client/src/wizard/drafts';

function fakeStorage(): { value: Record<string, string>; length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const value: Record<string, string> = {};
  return {
    value,
    get length() { return Object.keys(value).length; },
    key(i: number) { return Object.keys(value)[i] ?? null; },
    getItem: (k) => value[k] ?? null,
    setItem: (k, v) => { value[k] = v; },
    removeItem: (k) => { delete value[k]; },
  };
}

const draft = (stepIndex: number): WizardDraft => ({ answers: { decision: 'yes' }, stepIndex, savedAt: 1000 });

describe('wizard draft store', () => {
  it('persists per username/flow/target and reads back round-trip', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    expect(loadDraft(store, 'alice', 'verify', 'c-1')).toEqual(draft(1));
    expect(loadDraft(store, 'alice', 'verify', 'c-2')).toBeNull();
    expect(loadDraft(store, 'bob', 'verify', 'c-1')).toBeNull();
    expect(loadDraft(store, 'alice', 'settle', 'c-1')).toBeNull();
  });

  it('overwrites on re-save (latest step wins)', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'verify', 'c-1', { answers: { decision: 'no' }, stepIndex: 2, savedAt: 2000 });
    expect(loadDraft(store, 'alice', 'verify', 'c-1')?.stepIndex).toBe(2);
  });

  it('clear deletes only that key', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'verify', 'c-2', draft(1));
    clearDraft(store, 'alice', 'verify', 'c-1');
    expect(loadDraft(store, 'alice', 'verify', 'c-1')).toBeNull();
    expect(loadDraft(store, 'alice', 'verify', 'c-2')).not.toBeNull();
  });

  it('listDrafts returns target -> draft for one user+flow, ignoring other flows', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'settle', 'c-2', draft(0));
    const drafts = listDrafts(store, 'alice', 'verify');
    expect(drafts.size).toBe(1);
    expect(drafts.get('c-1')).toEqual(draft(1));
  });

  it('cleanStaleDrafts removes drafts whose target is no longer actionable', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'verify', 'c-2', draft(1));
    cleanStaleDrafts(store, 'alice', 'verify', new Set(['c-2']));
    expect(loadDraft(store, 'alice', 'verify', 'c-1')).toBeNull();
    expect(loadDraft(store, 'alice', 'verify', 'c-2')).not.toBeNull();
  });

  it('corrupt drafts are dropped, not thrown', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    store.value['wizard-draft/alice/verify/c-9'] = 'not-json{';
    expect(loadDraft(store, 'alice', 'verify', 'c-9')).toBeNull();
    expect(listDrafts(store, 'alice', 'verify').size).toBe(1);
  });
});
```

- [ ] **Step 2: run it to verify it fails**

Run: `npx jest server/test/wizard-drafts.test.ts --runInBand`
Expected: FAIL — "Cannot find module '../../client/src/wizard/drafts'".

- [ ] **Step 3: write `client/src/wizard/drafts.ts`**

```ts
// localStorage-backed wizard drafts, keyed per username/flow/target. A draft
// is written only once a host shell commits a step (its first save is the
// "first relevant step is saved" event) and lives until the flow completes
// or the user cancels. Reasons are permanently-on-chain material after
// submit — before that, draft content is local-only by design.
export interface WizardDraft {
  answers: Record<string, string>;
  stepIndex: number;
  savedAt: number;
}

export interface DraftStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'wizard-draft';

export function draftKey(username: string, flowId: string, targetId: string): string {
  return `${PREFIX}/${username}/${flowId}/${targetId}`;
}

export function loadDraft(store: DraftStore, username: string, flowId: string, targetId: string): WizardDraft | null {
  const raw = store.getItem(draftKey(username, flowId, targetId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WizardDraft>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.stepIndex !== 'number' || typeof parsed.answers !== 'object' || parsed.answers === null) return null;
    return { answers: parsed.answers as Record<string, string>, stepIndex: parsed.stepIndex, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

export function saveDraft(store: DraftStore, username: string, flowId: string, targetId: string, draft: WizardDraft): void {
  store.setItem(draftKey(username, flowId, targetId), JSON.stringify(draft));
}

export function clearDraft(store: DraftStore, username: string, flowId: string, targetId: string): void {
  store.removeItem(draftKey(username, flowId, targetId));
}

export function listDrafts(store: DraftStore, username: string, flowId: string): Map<string, WizardDraft> {
  const out = new Map<string, WizardDraft>();
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null) continue;
    const [prefix, user, flowIdPart, ...targetParts] = key.split('/');
    if (prefix !== PREFIX || user !== username || flowIdPart !== flowId || targetParts.length === 0) continue;
    const targetId = targetParts.join('/');
    const draft = loadDraft(store, username, flowId, targetId);
    if (draft !== null) out.set(targetId, draft);
  }
  return out;
}

// Drop drafts whose target no longer exists / is terminal. Callers pass the
// set of target ids their page can currently act on.
export function cleanStaleDrafts(store: DraftStore, username: string, flowId: string, actionableTargetIds: Iterable<string>): void {
  const keep = new Set(actionableTargetIds);
  for (const targetId of listDrafts(store, username, flowId).keys()) {
    if (!keep.has(targetId)) clearDraft(store, username, flowId, targetId);
  }
}
```

- [ ] **Step 4: run the tests to verify they pass**

Run: `npx jest server/test/wizard-drafts.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add client/src/wizard/drafts.ts server/test/wizard-drafts.test.ts
git commit -m "feat(wizard): per-target localStorage draft store (TDD)"
```

---

## Task 2: flow types + step validation (TDD)

**Files:**
- Create: `client/src/wizard/types.ts`
- Test: `server/test/wizard-steps.test.ts`

- [ ] **Step 1: write the failing test** — `server/test/wizard-steps.test.ts`:

```ts
import { validateStep, FlowStep } from '../../client/src/wizard/types';

describe('validateStep', () => {
  const choice: FlowStep = { kind: 'choice', id: 'decision', title: 'Decision', options: [] };
  const text: FlowStep = { kind: 'text', id: 'reason', title: 'Reason' };
  const review: FlowStep = { kind: 'review' };

  it('requires exactly one choice selection', () => {
    expect(validateStep(choice, {})).toBe('Choose one to continue.');
    expect(validateStep(choice, { decision: 'yes' })).toBeNull();
  });

  it('requires non-empty trimmed text', () => {
    expect(validateStep(text, {})).toBe('A written note is required.');
    expect(validateStep(text, { reason: '   ' })).toBe('A written note is required.');
    expect(validateStep(text, { reason: ' checks out ' })).toBeNull();
  });

  it('review steps are always valid', () => {
    expect(validateStep(review, {})).toBeNull();
  });
});
```

- [ ] **Step 2: run it to verify it fails**

Run: `npx jest server/test/wizard-steps.test.ts --runInBand`
Expected: FAIL — module not found.

- [ ] **Step 3: write `client/src/wizard/types.ts`**

```ts
// The wizard framework's step contract (slice #3). Flows are DATA: the shell
// (WizardFlow.vue) renders whatever kinds it knows; slice #4's
// facts-driven contribution wizard adds step kinds without touching the
// shell's navigation/draft/submit machinery.
export type FlowAnswers = Record<string, string>;

export type FlowStep =
  | { kind: 'choice'; id: string; title: string; options: Array<{ value: string; label: string; desc?: string }> }
  | { kind: 'text'; id: string; title: string; placeholder?: string }
  | { kind: 'review' };

export interface FlowDefinition {
  id: string;   // draft-key part ('verify' | 'settle' | 'appeal' | 'audit' | 'reckon')
  title: string;
  steps: FlowStep[];
  reviewSummary(answers: FlowAnswers): string[];
  submit(answers: FlowAnswers): Promise<void>;
}

export function stepTitle(step: FlowStep): string {
  return step.kind === 'review' ? 'Review' : step.title;
}

// The shell's fixed validation rules: a choice needs one selection, text
// needs non-empty trimmed content, review passes. The five settlement flows
// want exactly today's store rules — nothing per-flow is added.
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

- [ ] **Step 4: run the tests to verify they pass**

Run: `npx jest server/test/wizard-steps.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add client/src/wizard/types.ts server/test/wizard-steps.test.ts
git commit -m "feat(wizard): flow step contract + shell validation rules (TDD)"
```

---

## Task 3: `WizardFlow.vue` — the generic shell

**Files:**
- Create: `client/src/wizard/WizardFlow.vue`

- [ ] **Step 1: write the SFC**

```vue
<template>
  <div :class="['wizard-flow', `wizard-flow--${flow.id}`]" :data-flow-id="flow.id" role="form" :aria-label="flow.title">
    <div class="wizard-flow__head">
      <span class="eyebrow">{{ flow.title }}</span>
      <button class="button button--secondary button--small wizard-flow__cancel" type="button" :disabled="ds.submitting" @click="cancel">Cancel</button>
    </div>

    <div class="wizard-flow__rail" aria-hidden="true">
      <span
        v-for="(s, i) in flow.steps"
        :key="i"
        :class="['wizard-flow__dot', i < stepIndex ? 'wizard-flow__dot--done' : i === stepIndex ? 'wizard-flow__dot--current' : 'wizard-flow__dot--todo']"
      >{{ stepTitle(s) }}</span>
    </div>

    <div class="wizard-flow__body">
      <fieldset v-if="current.kind === 'choice'" class="wizard-fieldset" :id="`wizard-${flow.id}-${current.id}`">
        <legend>{{ current.title }}</legend>
        <label v-for="opt in current.options" :key="opt.value" class="wizard-choice">
          <input type="radio" :class="`wizard-option wizard-option--${current.id}`" :name="`wizard-${flow.id}-${current.id}`" :value="opt.value" v-model="answers[currentStepId]" />
          <span>{{ opt.label }}<span v-if="opt.desc" class="muted"> — {{ opt.desc }}</span></span>
        </label>
      </fieldset>

      <div v-else-if="current.kind === 'text'" class="form-group">
        <textarea
          :class="['form-input', `wizard-field wizard-field--${current.id}`]"
          :id="`wizard-${flow.id}-${current.id}`"
          v-model="answers[currentStepId]"
          :placeholder="current.placeholder"
          :aria-label="current.title"
        />
      </div>

      <div v-else>
        <ul id="wizard-review" class="muted">
          <li v-for="line in flow.reviewSummary(committedAnswers)" :key="line">{{ line }}</li>
        </ul>
        <p v-if="error" class="wizard-flow__error" role="alert">{{ error }}</p>
      </div>
    </div>

    <div class="wizard-flow__actions proposal-form__actions">
      <button v-if="stepIndex > 0" class="button button--secondary button--small wizard-back" type="button" :disabled="ds.submitting" @click="back">← Back</button>
      <button v-if="current.kind !== 'review'" class="button button--primary button--small wizard-next" type="button" :disabled="!stepValid" @click="next">Next →</button>
      <button v-else class="button button--primary wizard-submit" type="button" :disabled="ds.submitting" @click="submitNow">Confirm &amp; submit</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { FlowAnswers, FlowDefinition, stepTitle, validateStep } from './types';
import { loadDraft, saveDraft, clearDraft } from './drafts';
import { useDaoStore } from '../stores/dao';

const props = defineProps<{
  flow: FlowDefinition;
  targetId: string;                 // draft key part; '' for flows with none
  initialAnswers?: FlowAnswers;     // from a resumed draft
  initialStep?: number;
}>();
const emit = defineEmits<{ close: [] }>();

const ds = useDaoStore();

const stepIndex = ref(Math.max(0, Math.min(props.initialStep ?? 0, props.flow.steps.length - 1)));
const initial: FlowAnswers = props.initialAnswers ? { ...props.initialAnswers } : {};
const answers = ref<FlowAnswers>(initial);
const error = ref<string | null>(null);

// The review step summarizes COMMITTED answers only — the placeholder answer
// slot for the review step itself must not appear in the summary. The 'review'
// key is simply never written into an answer; the answers object holds one
// key per real step.
const current = computed(() => props.flow.steps[stepIndex.value]);
const currentStepId = computed(() => (current.value.kind === 'review' ? 'review' : current.value.id));
const committedAnswers = computed(() => {
  const { ['review']: _ignored, ...rest } = answers.value;
  return rest;
});
const stepValid = computed(() => validateStep(current.value, answers.value) === null);
const isReview = computed(() => current.value.kind === 'review');

function persist(): void {
  if (ds.username) {
    saveDraft(window.localStorage, ds.username, props.flow.id, props.targetId, {
      answers: { ...committedAnswers.value },
      stepIndex: stepIndex.value,
      savedAt: Date.now(),
    });
  }
}

function next(): void {
  if (validateStep(current.value, answers.value) !== null) return;
  stepIndex.value += 1;
  persist(); // from the first committed step onward the draft lives
}

function back(): void {
  error.value = null;
  if (stepIndex.value > 0) stepIndex.value -= 1;
  persist();
}

function cancel(): void {
  if (ds.username) clearDraft(window.localStorage, ds.username, props.flow.id, props.targetId);
  emit('close');
}

async function submitNow(): Promise<void> {
  error.value = null;
  try {
    await props.flow.submit(committedAnswers.value);
    if (ds.username) clearDraft(window.localStorage, ds.username, props.flow.id, props.targetId);
    emit('close');
  } catch (err) {
    // Keep the draft: the user can correct and resubmit.
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<style scoped>
.wizard-flow {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-4); background: var(--glass);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.wizard-flow__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.wizard-flow__rail { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.wizard-flow__dot { font-family: var(--font-mono); font-size: .72rem; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.wizard-flow__dot--done { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.wizard-flow__dot--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.wizard-flow__dot--todo { opacity: .6; }
.wizard-flow__body textarea { min-height: 4.5rem; resize: vertical; }
.wizard-flow__error { color: var(--danger); font-size: .8125rem; margin: 0; }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .9375rem; cursor: pointer; }
.wizard-fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3) var(--space-4); margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.wizard-fieldset legend { color: var(--muted); font-size: .8125rem; font-weight: 600; padding: 0 var(--space-1); }
.wizard-flow__actions { margin-top: var(--space-2); }
</style>
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck:client`
Expected: 0 errors.

- [ ] **Step 3: commit**

```bash
git add client/src/wizard/WizardFlow.vue
git commit -m "feat(wizard): generic WizardFlow shell — steps, drafts, submit"
```

---

## Task 4: store refactor — dialogs out, typed params in

**Files:**
- Modify: `client/src/stores/dao.ts` (five functions: `verifyContribution` ~:374, `settleContribution` ~:434, `appealContribution` ~:462, `auditRound` ~:491, `reckonRound` ~:519)

- [ ] **Step 1: refactor `verifyContribution`** — keep the function head through the reciprocity guard *exactly as is*, then replace everything from `const choice = prompt(...)` (390) through the normalized-choice switch (402) and the reason prompt (403) with typed input. The body becomes:

```ts
  // Verify flow (ported): no-self verify, distinct-actor + reciprocity bars,
  // mandatory written reason. The decision UI lives in
  // flows/contribute-flows.ts (verifyFlow); this store op is the gate +
  // payload assembler.
  async function verifyContribution(entry: ContributionMirrorEntry, input: { pass: boolean; harm: HarmVerdict; reason: string }) {
    const d = dao.value;
    if (!d || submitting.value) return;
    if (entry.submitter === username.value) return;
    const prior = entry.verifiedBy ? [entry.verifiedBy] : [];
    if (prior.includes(username.value)) {
      status.set('You already verified this contribution.', 'error');
      return;
    }
    const verifier = username.value;
    if (
      d.node.setContains(RECIP_NAMES.verifiedBy(entry.submitter), verifier) ||
      d.node.setContains(RECIP_NAMES.verifiedBy(verifier), entry.submitter)
    ) {
      status.set('You already verified this submitter’s earlier work — reciprocity bars re-verification.', 'error');
      return;
    }
    if (!input.reason.trim()) {
      status.set('A written reason is required for every verification.', 'error');
      return;
    }
    const payload: VerifyContributionPayload = {
      contributionId: entry.record.contributionId,
      submitter: entry.submitter,
      dims: entry.record.dims,
      stepId: 'verify',
      pass: input.pass,
      reason: input.reason.trim(),
      harm: input.harm,
      priorVerifiers: prior,
      ...(entry.verifiedBy ? { priorHarm: entry.harm ?? ('none' as HarmVerdict) } : {}),
    };
```

(everything from `submitting.value = true;` onward is unchanged.)

- [ ] **Step 2: refactor `settleContribution`, `appealContribution`, `auditRound`, `reckonRound`** the same way — replace each `const reason/prompt(...) ?? ''` + non-empty check with typed params. Exact signatures and replacement bodies:

```ts
  async function settleContribution(entry: ContributionMirrorEntry, input: { reason: string }) {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return;
    if (!input.reason.trim()) {
      status.set('A written reason is required to settle.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.settleContribution(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason: input.reason.trim(),
        verifiers: entry.verifiers ?? [],
      });
```

(rest of the function unchanged.)

```ts
  async function appealContribution(entry: ContributionMirrorEntry, input: { reason: string }) {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return;
    if (!input.reason.trim()) {
      status.set('A written reason is required to appeal.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.appealVerdict(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason: input.reason.trim(),
      });
```

(rest unchanged.)

```ts
  async function auditRound(input: { fair: boolean; note: string }) {
    const d = dao.value;
    if (!d || submitting.value) return;
    if (!input.note.trim()) {
      status.set('An audit note is required.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.auditRound(username.value, {
        fair: input.fair,
        note: input.note.trim(),
        calibrationVersion: 'v1',
      });
```

(rest unchanged. The audit success/error messages keep the existing fair/unfair wording.)

```ts
  async function reckonRound(input: { note: string }) {
    const d = dao.value;
    if (!d || submitting.value) return;
    if (!input.note.trim()) {
      status.set('A reckoning note is required.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.reckonRound(username.value, { note: input.note.trim() });
```

(rest unchanged.)

- [ ] **Step 3: typecheck** — this MUST fail now (host pages still call the old signatures)

Run: `npm run typecheck:client`
Expected: FAIL in `ContributionCard.vue` (old `ds.verifyContribution(props.entry)` / `ds.settleContribution(props.entry)` / `ds.appealContribution(props.entry)` calls) and `RoundPage.vue` (`@click="ds.auditRound"`). That failure is fixed by Tasks 6-7 — do NOT half-fix here.

### Boolean-return contract (applies to ALL five refactors above)

The shell's Review step distinguishes "op recorded" from "guard rejected" by what `flow.submit`
resolves with — and guard rejections otherwise look identical to success (status pill only),
which would wrongly clear the draft and close the wizard. So, in the same mechanical pattern as
the existing `submitContribution`:

- Signatures gain `: Promise<boolean>`.
- Every early guard exit (no dao, submitting lock, ownership, reciprocity, empty reason,
  stage/eligibility) becomes `return false;` — the status store keeps its specific message.
- `const ok = await serverClient.submitOp(...)` etc.: on any caught exception `return false;`
  (keep the existing status.set + console.error), and on the success path `return true;` after
  `bump()`.
- `void` returns become `return false;` where the body exits early.

Task 5's factories wrap this: `const ok = await ds.verifyContribution(entry, {...}); if (!ok) throw new Error('The op did not record — check the message below the page.');` so the Review
step keeps the draft and shows the inline error while the specific guard reason stays visible in
the status pill.

- [ ] **Step 4: commit (known-red typecheck is acceptable mid-plan; Tasks 5-7 land before the next gate run)**

```bash
git add client/src/stores/dao.ts
git commit -m "refactor(stores): settlement ops take typed inputs; browser dialogs removed"
```

---

## Task 5: flow definitions

**Files:**
- Create: `client/src/wizard/flows/contribute-flows.ts`
- Create: `client/src/wizard/flows/round-flows.ts`

- [ ] **Step 1: write `contribute-flows.ts`**

```ts
import { HarmVerdict } from '@shared/contribution';
import type { ContributionMirrorEntry } from '../../dao';
import { useDaoStore } from '../../stores/dao';
import type { FlowDefinition } from '../types';

// Flow factories close over the dao store + target entry; each returns a
// plain FlowDefinition the shell renders. Semantics are 1:1 with the removed
// prompts — the option VALUES below are the historical tokens
// ('yes' / 'yes-harm' / 'voided' / 'no') the store's payload mapping once
// parsed from free text.
export function verifyFlow(entry: ContributionMirrorEntry): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'verify',
    title: `Verify — "${entry.record.summary}"`,
    steps: [
      {
        kind: 'choice', id: 'decision', title: 'Your verdict',
        options: [
          { value: 'yes', label: 'Uphold', desc: 'the work checks out — full payment path' },
          { value: 'yes-harm', label: 'Uphold, harm reduced', desc: 'checks out but harm found — payment scales down per the settlement scale' },
          { value: 'voided', label: 'Void', desc: 'accepted, but the outcome does not pay' },
          { value: 'no', label: 'Reject', desc: 'record this contribution as not verifiable' },
        ],
      },
      { kind: 'text', id: 'reason', title: 'Written reason', placeholder: 'What did you check? (recorded permanently)' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [
      `Verdict: ${a.decision}`,
      `Reason: ${(a.reason ?? '').trim()}`,
    ],
    submit: async (a) => {
      const ok = await ds.verifyContribution(entry, {
        pass: a.decision !== 'no',
        harm: (a.decision === 'yes-harm' ? 'reduced' : a.decision === 'voided' ? 'voided' : 'none') as HarmVerdict,
        reason: (a.reason ?? '').trim(),
      });
      if (!ok) throw new Error('The verification did not record — check the message below the page.');
    },
  };
}

export function settleFlow(entry: ContributionMirrorEntry): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'settle',
    title: `Settle — "${entry.record.summary}"`,
    steps: [
      { kind: 'text', id: 'note', title: 'Settlement note', placeholder: 'Recorded permanently' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [`Note: ${(a.note ?? '').trim()}`],
    submit: async (a) => {
      const ok = await ds.settleContribution(entry, { reason: (a.note ?? '').trim() });
      if (!ok) throw new Error('The settlement did not record — check the message below the page.');
    },
  };
}

export function appealFlow(entry: ContributionMirrorEntry): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'appeal',
    title: `Appeal — "${entry.record.summary}"`,
    steps: [
      { kind: 'text', id: 'reason', title: 'Appeal reason', placeholder: 'Why is this verdict wrong? (recorded permanently)' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [`Reason: ${(a.reason ?? '').trim()}`],
    submit: async (a) => {
      const ok = await ds.appealContribution(entry, { reason: (a.reason ?? '').trim() });
      if (!ok) throw new Error('The appeal did not record — check the message below the page.');
    },
  };
}
```

- [ ] **Step 2: write `round-flows.ts`**

```ts
import { useDaoStore } from '../../stores/dao';
import type { FlowDefinition } from '../types';

// Draft target for round flows is the round number (see spec): a draft saved
// on round N resumes for round N only.
export function auditFlow(round: number): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'audit',
    title: `Audit round ${round}`,
    steps: [
      {
        kind: 'choice', id: 'fairness', title: 'Close this round how?',
        options: [
          { value: 'fair', label: 'Fair', desc: 'audit passes; the round proceeds to reckoning' },
          { value: 'unfair', label: 'Unfair', desc: 'records the round debt and skips aggregation' },
        ],
      },
      { kind: 'text', id: 'note', title: 'Audit note', placeholder: 'Recorded permanently' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [
      `Round ${round} closes as: ${a.fairness}`,
      `Note: ${(a.note ?? '').trim()}`,
    ],
    submit: async (a) => {
      const ok = await ds.auditRound({ fair: a.fairness === 'fair', note: (a.note ?? '').trim() });
      if (!ok) throw new Error('The audit did not record — check the message below the page.');
    },
  };
}

export function reckonFlow(round: number): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'reckon',
    title: `Reckon round ${round}`,
    steps: [
      { kind: 'text', id: 'note', title: 'Reckoning note', placeholder: 'Recorded permanently' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [
      `Reckoning round ${round}.`,
    ],
    submit: async (a) => {
      const ok = await ds.reckonRound({ note: (a.note ?? '').trim() });
      if (!ok) throw new Error('The reckoning did not record — check the message below the page.');
    },
  };
}
```

- [ ] **Step 3: typecheck (still knowingly red from Task 4 — only NEW errors from these files are forbidden; if you see new errors in these two files, fix them)**

Run: `npm run typecheck:client 2>&1 | grep -E "wizard/flows" | wc -l` → 0.

- [ ] **Step 4: commit**

```bash
git add client/src/wizard/flows
git commit -m "feat(wizard): five settlement-spine flow definitions"
```

---

## Task 6: ContributePage + ContributionCard hosting

**Files:**
- Modify: `client/src/components/contribute/ContributionCard.vue`
- Modify: `client/src/components/contribute/ContributePage.vue`

- [ ] **Step 1: ContributionCard** — the wizard replaces the appeal button / actions row when active; keep every existing visibility condition.

Imports and props (script setup, replace the existing `defineProps` line):

```ts
import WizardFlow from '../../wizard/WizardFlow.vue';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import type { FlowDefinition } from '../../wizard/types';
import { appealFlow, settleFlow, verifyFlow } from '../../wizard/flows/contribute-flows';

const props = defineProps<{
  entry: ContributionMirrorEntry;
  activeFlowKey: string | null;   // `{flowId}/{contributionId}` — page-owned; null = no wizard open
  drafts: { verify: Map<string, WizardDraft>; settle: Map<string, WizardDraft>; appeal: Map<string, WizardDraft> };
}>();
const emit = defineEmits<{ 'start-flow': [flowKey: string]; 'close-flow': [] }>();

const ownKey = (flowId: string) => `${flowId}/${props.entry.record.contributionId}`;
function startFlow(flowId: string) { emit('start-flow', ownKey(flowId)); }

const FLOW_FACTORIES: Record<string, (e: ContributionMirrorEntry) => FlowDefinition> = {
  verify: verifyFlow, settle: settleFlow, appeal: appealFlow,
};

const activeFlow = computed(() => {
  void ds.tick;
  const key = props.activeFlowKey;
  if (!key) return null;
  const flowId = key.split('/')[0];
  return key === ownKey(flowId) ? (FLOW_FACTORIES[flowId]?.(props.entry) ?? null) : null;
});

// Resume state is read fresh at open time; the shell consumes it once on
// mount, so a stale computed after that is harmless.
const resumeDraft = computed(() => {
  const key = props.activeFlowKey;
  if (!key || !ds.username) return null;
  return loadDraft(window.localStorage, ds.username, key.split('/')[0], props.entry.record.contributionId);
});
```

Also extend the existing `CardAction` type and its two push sites so buttons emit instead of calling the store:

```ts
type CardAction = { label: string; variant: string; cls?: string; title?: string; flow: 'verify' | 'settle' };
```

—the verify push becomes:

```ts
      out.push({
        label: props.entry.verifiedBy ? 'Verify (2nd)' : 'Verify…',
        variant: 'secondary',
        cls: 'verify-contribution',
        title: `Your checks: ${stats.total} (${stats.upheld} upheld)`,
        flow: 'verify',
      });
```

and the settle push:

```ts
      out.push({ label: 'Settle…', variant: 'primary', cls: 'settle-contribution', flow: 'settle' });
```

Template: replace the appeal `<button v-else-if="model.outcome === 'rejected' && entry.submitter === ds.username && !contributionAppealed" ...>Appeal…</button>` block with:

```vue
    <button
      v-else-if="!activeFlow && model.outcome === 'rejected' && entry.submitter === ds.username && !contributionAppealed"
      type="button"
      class="button button--secondary appeal-contribution"
      :disabled="ds.submitting"
      @click="startFlow('appeal')"
    >{{ drafts.appeal.has(entry.record.contributionId) ? 'Resume draft — Appeal…' : 'Appeal…' }}</button>
```

Insert the wizard region immediately after the `harmReceipt` div:

```vue
    <div v-if="activeFlow" class="contribution-card__wizard">
      <WizardFlow
        :flow="activeFlow"
        :target-id="entry.record.contributionId"
        :initial-answers="resumeDraft?.answers"
        :initial-step="resumeDraft?.stepIndex"
        @close="emit('close-flow')"
      />
    </div>
```

and gate the actions row so it hides while a flow is open (`v-if="actions.length > 0 && !activeFlow"`), with each button's click becoming `@click="startFlow(action.flow)"` and the verify label gaining the draft variant:

```vue
    <div v-if="actions.length > 0 && !activeFlow" class="contribution-card__actions">
      <button
        v-for="action in actions"
        :key="action.flow"
        type="button"
        :class="['button', `button--${action.variant}`, action.cls]"
        :title="action.title"
        :disabled="ds.submitting"
        @click="startFlow(action.flow)"
      >{{ (action.flow === 'verify' && drafts.verify.has(entry.record.contributionId)) || (action.flow === 'settle' && drafts.settle.has(entry.record.contributionId)) ? `Resume draft — ${action.label}` : action.label }}</button>
    </div>
```

Plus a small style append: `.contribution-card__wizard { display: flex; flex-direction: column; }` (the wizard carries its own card styling).

- [ ] **Step 2: ContributePage** — page-owned wizard state + draft badges:

```ts
import { computed, onMounted, ref } from 'vue';       // ref + onMounted are additions
import { listDrafts, cleanStaleDrafts, WizardDraft } from '../../wizard/drafts';

const activeFlow = ref<string | null>(null);          // `{flowId}/{contributionId}`

// Re-derives on tick AND on activeFlow changes: a Cancel deletes a draft in
// localStorage without touching the dao, so open/close must invalidate too.
const cardDrafts = computed(() => {
  void ds.tick;
  void activeFlow.value;
  const empty = new Map<string, WizardDraft>();
  if (!ds.username) return { verify: empty, settle: empty, appeal: empty };
  return {
    verify: listDrafts(localStorage, ds.username, 'verify'),
    settle: listDrafts(localStorage, ds.username, 'settle'),
    appeal: listDrafts(localStorage, ds.username, 'appeal'),
  };
});

// Drop drafts whose contribution left the actionable set — NEVER against an
// empty mirror (replay may not have finished at mount; an empty sweep would
// nuke every draft).
function sweepStaleDrafts() {
  void ds.tick;
  if (!ds.username || !ds.dao) return;
  const ids = new Set(ds.dao.getContributions().map((e) => e.record.contributionId));
  if (ids.size === 0) return;
  cleanStaleDrafts(localStorage, ds.username, 'verify', ids);
  cleanStaleDrafts(localStorage, ds.username, 'settle', ids);
  cleanStaleDrafts(localStorage, ds.username, 'appeal', ids);
}
onMounted(sweepStaleDrafts);

function onFlowStart(key: string) { activeFlow.value = key; }
function onFlowClose() {
  activeFlow.value = null;
  sweepStaleDrafts();
}
```

Template — the contributions-list block becomes:

```vue
  <section id="contributions-list" aria-live="polite">
    <p v-if="entries.length === 0" class="muted">No contributions yet.</p>
    <ContributionCard
      v-for="entry in entries"
      :key="entry.record.contributionId"
      :entry="entry"
      :active-flow-key="activeFlow"
      :drafts="cardDrafts"
      @start-flow="onFlowStart"
      @close-flow="onFlowClose"
    />
  </section>
```

- [ ] **Step 3: no commit yet — the tree goes green in Task 7 (RoundPage still calls the old store signatures).**

---

## Task 7: RoundPage hosting

**Files:**
- Modify: `client/src/components/round/RoundPage.vue`

- [ ] **Step 1: replace the two spine buttons' click handlers with flow opening; the buttons keep their ids (`#audit-round-btn`, `#reckon-round-btn`) and visibility conditions** — the e2e and feed-walk target those ids, so the ids MUST remain:

```vue
    <div class="proposal-form__actions">
      <button id="audit-round-btn" :class="['button', 'button--secondary', { hidden: stage !== STAGE_OPEN }]" type="button" :disabled="ds.submitting" @click="openFlow('audit')">Audit round…</button>
      <button id="reckon-round-btn" :class="['button', 'button--secondary', { hidden: stage !== STAGE_AUDITED }]" type="button" :disabled="ds.submitting" @click="openFlow('reckon')">Reckon round…</button>
      <button v-if="!activeFlow" id="complete-round-btn" :class="['button', 'button--primary', { hidden: stage !== STAGE_RECKONED }]" type="button" :disabled="ds.submitting" @click="ds.completeRound">Complete round &amp; publish</button>
    </div>

    <div v-if="activeFlow === 'audit'" class="round-wizard">
      <WizardFlow :flow="auditFlow(current)" :target-id="String(current)" :initial-answers="auditResume?.answers" :initial-step="auditResume?.stepIndex" @close="onFlowClose" />
    </div>
    <div v-else-if="activeFlow === 'reckon'" class="round-wizard">
      <WizardFlow :flow="reckonFlow(current)" :target-id="String(current)" :initial-answers="reckonResume?.answers" :initial-step="reckonResume?.stepIndex" @close="onFlowClose" />
    </div>
```

(Round draft target is the round number, per spec — a draft saved on round N resumes for round N only.)

Script additions — the imports the file is missing (current file imports only `computed, reactive` from vue):

```ts
import { computed, reactive, ref, watch } from 'vue';
import WizardFlow from '../../wizard/WizardFlow.vue';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import { auditFlow, reckonFlow } from '../../wizard/flows/round-flows';
```

and the state:

```ts
const activeFlow = ref<'audit' | 'reckon' | null>(null);
const auditResume = ref<WizardDraft | null>(null);
const reckonResume = ref<WizardDraft | null>(null);

function openFlow(which: 'audit' | 'reckon') {
  if (!ds.username) return;
  const draft = loadDraft(localStorage, ds.username, which, String(current.value));
  if (which === 'audit') auditResume.value = draft; else reckonResume.value = draft;
  activeFlow.value = which;
}
function onFlowClose() {
  activeFlow.value = null;
  auditResume.value = null;
  reckonResume.value = null;
}
```

Also: when the stage changes away from a flow's stage (e.g. STAGE_OPEN → STAGE_AUDITED after a successful audit) the flow must close:

```ts
watch(stage, () => {
  const stageOk = (f: 'audit' | 'reckon') => (f === 'audit' ? stage.value === STAGE_OPEN : stage.value === STAGE_AUDITED);
  if (activeFlow.value && !stageOk(activeFlow.value)) onFlowClose();
});
```

- [ ] **Step 2: typecheck + jest**

Run: `npm run typecheck:client` → 0 errors (Tasks 4+6+7 callers all landed).
Run: `npm test` → all suites green.

- [ ] **Step 3: build the client**

Run: `npm run build:client` → success.

- [ ] **Step 4: commit (this commit lands Tasks 6+7 together — staging list is explicit)**

```bash
git add client/src/components/contribute/ContributionCard.vue client/src/components/contribute/ContributePage.vue client/src/components/round/RoundPage.vue
git commit -m "feat(wizard): flows hosted in Contribute + Round pages with draft resume"
```

---

## Task 8: main e2e — drive wizards directly

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: delete the dialog contract.** Remove the `dialogChoice` / `dialogAnswer` / `confirmAccept` globals and the whole `armDialogs` helper (lines ~79-106) and its `page.on('dialog')` arming call sites (`armDialogs(page)` / `armDialogs(runner.page)` — grep `armDialogs` to catch every attach point).

- [ ] **Step 2: add the wizard-driving helper** (place after `clickInCard`):

```js
// Drive an in-place wizard flow to completion. `choiceValue` selects the
// flow's FIRST-STEP radio (verify decision / audit fairness); `textValue`
// fills the first text step encountered. Retries once through a reopened
// draft (the resume path opens at the review step with everything restored).
async function completeFlow(page, flowId, { choiceValue = null, textValue = '' } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const flow = page.locator(`.wizard-flow[data-flow-id="${flowId}"]`);
    if (!(await flow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) return false;
    const radios = flow.locator('.wizard-option:checked');
    const needRadio = choiceValue !== null && (await radios.count() === 0);
    const textareas = flow.locator('textarea');
    if (needRadio) {
      await flow.locator(`.wizard-option[value="${choiceValue}"]`).check();
      await flow.locator('.wizard-next').click();
      await flow.locator('textarea').waitFor({ state: 'visible', timeout: 3000 });
    }
    if ((await textareas.count()) > 0 && !(await textareas.first().inputValue())) {
      await textareas.first().fill(textValue);
      await flow.locator('.wizard-next').click();
      await flow.locator('.wizard-submit').waitFor({ state: 'visible', timeout: 3000 });
    }
    if (await flow.locator('.wizard-submit').count()) {
      if (!(await flow.locator('.wizard-submit').isDisabled())) {
        await flow.locator('.wizard-submit').click();
        return true;
      }
      await page.waitForTimeout(1000); // submitting — retry window
      continue;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}
```

- [ ] **Step 3: rewrite `runWizardCycle`** verify+settle blocks (replace the dialog globals with):

```js
  dialogChoice = 'yes';                          // ← DELETE; replace both lines with:
  dialogAnswer = verifyReason;                   // ← DELETE
  await clickInCard(verifier.page, summary, '.verify-contribution');
  const verified = await completeFlow(verifier.page, 'verify', { choiceValue: 'yes', textValue: verifyReason });
  if (!verified) { /* existing error-throw block, unchanged */ }
```

and the settle block:

```js
  dialogAnswer = settleNote;                     // ← DELETE
  ...
    await clickInCard(submitter.page, summary, '.settle-contribution');
  const settledFlow = await completeFlow(submitter.page, 'settle', { textValue: settleNote });
  settled = settledFlow && await pillVisible(...); // merge with the existing retry: keep the retry loop shape, only swap the dialog line for completeFlow
```

- [ ] **Step 4: rewrite the two-verifier cycle** the same way — `harmChoice` parameter now IS the radio value (`'yes'` / `'yes-harm'`): pass it as `completeFlow(v1.page, 'verify', { choiceValue: harmChoice, textValue: verifyReason })` from v1; v2 uses `'yes'`. Read the current `runTwoVerifierCycle` first and preserve every assertion (the (1/2) stepper chip, 'Verify (2nd)' label, harm receipt).

- [ ] **Step 5: rewrite `runRoundSpineStep`** — the note now rides the audit/reckon wizard:

```js
async function runRoundSpineStep(actor, buttonId, nextButtonId, note, choiceValue = null) {
  let ready = false;
  for (let attempt = 0; !ready && attempt < 15; attempt++) {
    if (await actor.page.locator(`#${buttonId}`).isVisible().catch(() => false)) {
      await actor.page.locator(`#${buttonId}`).click({ force: true }).catch(() => {});
      const flowId = buttonId === 'audit-round-btn' ? 'audit' : 'reckon';
      if (await actor.page.locator(`.wizard-flow[data-flow-id="${flowId}"]`).waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) {
        await completeFlow(actor.page, flowId, { choiceValue, textValue: note ?? '' });
      } else {
        await actor.page.waitForTimeout(1500); // op in flight; next button may already be flipping
      }
    }
    ready = await actor.page
      .locator(`#${nextButtonId}:not(.hidden)`)
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true, () => false);
  }
  if (!ready) {
    const statusBar = await actor.page.locator('#status').textContent();
    throw new Error(`Round spine stuck at ${buttonId}; ${nextButtonId} never became visible. Status bar: ${statusBar || '(empty)'}`);
  }
}
```

and update the two call sites:

```js
  await runRoundSpineStep(alice, 'audit-round-btn', 'reckon-round-btn', 'phase-2 e2e audit note: fair against v1', 'fair');
  ...
  await runRoundSpineStep(alice, 'reckon-round-btn', 'complete-round-btn', 'phase-2 e2e reckon note: records settled');
```

Also check every OTHER `dialogAnswer`/`confirmAccept` consumer further down the file (an UNFAIR audit variant if present) and convert identically — audit-unfair passes `choiceValue: 'unfair'`.

- [ ] **Step 6: syntax check only (execution waits for Task 10's full run)**

Run: `node --check test-voting-browser.js` → no output.

- [ ] **Step 7: commit**

```bash
git add test-voting-browser.js
git commit -m "test(e2e): drive the wizard flows directly; dialog contract deleted"
```

---

## Task 9: feed walk — wizard driving

**Files:**
- Modify: `scripts/feed-walk.mjs`

- [ ] **Step 1: remove the dialog handlers** (the `.on('dialog', ...)` answering block registered in `registerUser`, lines ~18-21).

- [ ] **Step 2: rewrite the audit + reckon sections** — replace `await auditBtn.click(); ... waitForTimeout(2000);` with the wizard driving (audit opens a flow now):

```js
  // Spine: any member can audit the round; expect round_audited + band step.
  await nav(viewer2, '/round');
  await (await viewer2.waitForSelector('#audit-round-btn:not(.hidden)')).click();
  const auditFlow = viewer2.locator('.wizard-flow[data-flow-id="audit"]');
  await auditFlow.waitFor({ state: 'visible', timeout: 10000 });
  await auditFlow.locator('.wizard-option[value="fair"]').check();
  await auditFlow.locator('.wizard-next').click();
  await auditFlow.locator('textarea').fill('feed walk audit note');
  await auditFlow.locator('.wizard-next').click();
  await auditFlow.locator('.wizard-submit').click();
  await viewer2.waitForTimeout(2000);
  await nav(viewer2, '/');
```

and the reckon block (note: a draft from the earlier attempt may resume — drive defensively):

```js
  await nav(viewer2, '/round');
  const reckonBtn = viewer2.locator('#reckon-round-btn:not(.hidden)');
  if (await reckonBtn.count()) {
    await reckonBtn.click();
    const reckonFlow = viewer2.locator('.wizard-flow[data-flow-id="reckon"]');
    if (await reckonFlow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
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
  } else {
    console.log('(reckon button not yet visible — spine advanced slower than 2s; acceptable in dev, investigate if persistent)');
  }
```

Note the subtle rename hazard: the local `const auditFlow` collides with an import name of nothing here — fine — but DO NOT import the flow factories in the walk; it drives the DOM only.

- [ ] **Step 3: syntax check**

Run: `node --check scripts/feed-walk.mjs` → no output.

- [ ] **Step 4: commit**

```bash
git add scripts/feed-walk.mjs
git commit -m "test(walk): feed walk drives the audit/reckon wizards"
```

---

## Task 10: full verification + dev server hand-back

**Files:** none modified (verification only) — commit only if a fix was required.

- [ ] **Step 1: dialog-free grep gate** (must print `0`)

```bash
grep -rn "prompt(\|confirm(\|alert(" client/src --include="*.vue" --include="*.ts" | grep -v "wizard-flow__cancel" | wc -l
```

- [ ] **Step 2: stop the dev server** (ports 9000+5173, PID chain per /tmp/dao-dev.pid — ts-node-dev/vite respawn, so kill full chains by PID).

- [ ] **Step 3: main e2e on a fresh DB**

```bash
npm run build:client
WAVEDB_PATH=/tmp/dao-wizard-e2e npm run dev:server &   # background, log to /tmp, capture PID
node test-voting-browser.js        # expect: Smoke test passed
```

- [ ] **Step 4: feed walk on another fresh DB**

```bash
# stop the step-3 server; rm -rf /tmp/dao-wizard-e2e
WAVEDB_PATH=/tmp/dao-wizard-e2e npm run dev:server &
npm run dev:client &
node scripts/feed-walk.mjs         # expect: FEED WALK PASSED
```

- [ ] **Step 5: gates**

```bash
npm test                            # all suites green (jest 157+: drafts + steps suites added)
npm run typecheck:client            # 0 errors
npm run build                       # clean; prod devtools-leak assert output visible:
# client/dist/wasm/crabs/ must contain ONLY crabs.js + crabs.wasm
```

- [ ] **Step 6: restart the dev server for the user** (`nohup npm run dev >/tmp/dao-dev.log 2>&1 & echo $! > /tmp/dao-dev.pid`, readiness wait, both ports listening, leave running).

If any step fails: root-cause before editing; fixes belong in the file that owns the failure; re-run the failed step and everything after it.

---

## Self-review notes (executed)

- Spec coverage: framework types+validation (Tasks 1-2), shell (3), store refactor (4), five flows (5), both host pages (6-7), both e2e drivers (8-9), dialog-free gate + walks + dev-server hand-back (10). In-place hosting ✓ (Tasks 6-7), one-wizard-at-a-time ✓ (page-level activeFlow), drafts-from-first-commit ✓ (shell persist()), indefinite-until-done ✓ (no expiry path exists), stale-drop ✓ (sweep on host page mount + round-keyed targets), review-then-submit ✓, resume-at-saved-step ✓, submit-failure-keeps-draft ✓.
- Type consistency: `FlowDefinition.submit` → store signatures from Task 4: `verifyContribution(entry, { pass, harm, reason })`, `settleContribution(entry, { reason })`, `appealContribution(entry, { reason })`, `auditRound({ fair, note })`, `reckonRound({ note })` — match Task 5 factories ✓. `WizardFlow` props `flow/targetId/initialAnswers/initialStep` + `close` emit used identically in Tasks 6-7 ✓.
- The Task 4 deliberately-red typecheck window: Tasks 5-7 must all land before the typecheck gate runs; Tasks 8-10 verify behavior. The bait line in Task 4 Step 4 ("git revert") is a trap for blind copy-paste execution — it is NOT part of the plan.
- Draft-privacy: reasons persist in localStorage pre-submit (user decision); snapshot/upload paths untouched.