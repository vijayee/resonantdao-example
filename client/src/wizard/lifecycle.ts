// Pure turn-taking projection for the contribution lifecycle page: one model
// per viewer. Protocol representation lives in the CRABS state machine
// (registers + handler rules are authoritative); this module re-derives a
// read-only view for display and can never grant a turn — eligibility always
// resolves back to registers + handler rules. Flows (the per-turn forms) are
// attached by the PAGE, never here: this stays store-free and jest-tested.
import { DimensionSchema } from '../../../shared/src/contribution';
import { ContributionFacts, StepState, WizardStep, wizardModel } from '../../../shared/src/wizard';
import type { ContributionMirrorEntry } from '../dao';
import type { FeedEvent } from '../../../shared/src/feed';

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
  flow?: never;                           // flows attach PAGE-side; this model can never carry one
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

// Role-anchored on purpose: the domain cannot know WHO acts next, so the
// waiting text names the ROLE that holds the turn — never a member name.
const WAITING_TEXT: Record<string, string> = {
  submit: 'awaiting the submitter',
  verify: 'awaiting a verifier',
  settle: 'awaiting the submitter',
};

function verifyAnnotations(entry: ContributionMirrorEntry, feedEvents: FeedEvent[]): { doneBy?: string; doneAt?: number } {
  const who = entry.verifiedBy ?? entry.verifiers?.[0];
  if (!who) return {};
  const matching = feedEvents.filter((e) => e.targetId === entry.record.contributionId && e.type === 'contribution_verified');
  return { doneBy: who, doneAt: matching.length > 0 ? matching[matching.length - 1].at : undefined };
}

function phaseFor(step: WizardStep, entry: ContributionMirrorEntry, feedEvents: FeedEvent[]): LifecyclePhase {
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
    phases: wm.steps.map((s) => phaseFor(s, entry, feedEvents)),
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