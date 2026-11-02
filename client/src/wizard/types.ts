// The wizard framework's step contract (slice #3). Flows are DATA: the shell
// (WizardFlow.vue) renders whatever kinds it knows; slice #4's
// facts-driven contribution wizard adds step kinds without touching the
// shell's navigation/draft/submit machinery.
export type FlowAnswers = Record<string, string>;

export type FlowStep =
  | { kind: 'choice'; id: string; title: string; options: Array<{ value: string; label: string; desc?: string }> }
  | { kind: 'text'; id: string; title: string; placeholder?: string }
  | { kind: 'evidence'; id: string; title: string; pointerPlaceholder?: string }
  // Slice #4c: the members picker. Options are the FACTORY-screened eligible
  // list (ineligible members are omitted entirely, not greyed); count — fixed
  // or a function of the answers so far — is the exact number that must be
  // ticked. The answer serializes as a comma-joined string of names.
  | { kind: 'members'; id: string; title: string; options: string[]; count: number | ((answers: FlowAnswers) => number) }
  | { kind: 'review' };

export interface FlowDefinition {
  id: string;   // draft-key part ('verify' | 'settle' | 'appeal' | 'audit' | 'reckon' | 'publish' | 'contribute-new')
  title: string;
  // Slice #6a: the step list may be a function of the answers — the claim
  // family varies per chosen type (C_19 gains the recognized + record picks).
  // The shell resolves the list per render via flowSteps.
  steps: FlowStep[] | ((answers: FlowAnswers) => FlowStep[]);
  reviewSummary(answers: FlowAnswers, files?: Record<string, string | null>): string[];
  submit(answers: FlowAnswers, files?: Record<string, File | null>): Promise<void>;
}

// The shell's single resolution seam: whatever the flow declared, the rail,
// the current step, and the draft's index all read THIS list. Re-evaluated by
// the caller's reactivity (the answers are what vary).
export function flowSteps(def: FlowDefinition, answers: FlowAnswers): FlowStep[] {
  return typeof def.steps === 'function' ? def.steps(answers) : def.steps;
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
  if (step.kind === 'members') {
    const need = typeof step.count === 'function' ? step.count(answers) : step.count;
    const got = (answers[step.id] ?? '').split(',').filter(Boolean).length;
    return got === need ? null : `Choose exactly ${need} verifier(s).`;
  }
  // Evidence: optional at the shell level; the store's submit gate rejects
  // an evidence-less submission (both inputs empty) — not duplicated here.
  return null;
}
