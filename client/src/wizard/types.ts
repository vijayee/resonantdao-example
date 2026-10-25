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
