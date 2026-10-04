// Pure projection of replica contribution facts into a per-viewer wizard model.
// All lifecycle rules come from static step schemas; nothing here mutates state.
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