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
  waitingOn?: string;                     // role text (legacy) — or the remaining NAMED verifiers when targeted
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
// EXCEPTION: targeted verification carries the names in the protocol state —
// there the turn IS determinate and the text names the remaining people.
const WAITING_TEXT: Record<string, string> = {
  submit: 'awaiting the submitter',
  verify: 'awaiting a verifier',
  settle: 'awaiting the submitter',
};

// doneBy credits EVERY actor who completed the phase (a 2-verifier
// all-parties step joins both) — order-independent on feed events: the
// dao's feed accessor is newest-first, so pick the completion timestamp by
// the newest matching event's at, never array position.
function verifyAnnotations(entry: ContributionMirrorEntry, feedEvents: FeedEvent[]): { doneBy?: string; doneAt?: number } {
  const who = (entry.verifiers?.length ?? 0) > 1
    ? (entry.verifiers ?? []).join(' & ')
    : entry.verifiedBy ?? entry.verifiers?.[0];
  if (!who) return {};
  const matching = feedEvents.filter((e) => e.targetId === entry.record.contributionId && e.type === 'contribution_verified');
  const latest = matching.reduce<FeedEvent | null>((acc, e) => (acc === null || e.at > acc.at ? e : acc), null);
  return { doneBy: who, doneAt: latest ? latest.at : undefined };
}

// Targeted verification makes the actor DETERMINATE (protocol state!) —
// waiting names the remaining named verifiers; legacy keeps the role text.
function waitingText(step: WizardStep, facts: ContributionFacts, entry: ContributionMirrorEntry): string {
  if (step.stepId === 'verify' && facts.verifiers && facts.verifiers.length > 0) {
    const verified = entry.verifiers ?? [];
    const remaining = facts.verifiers.filter((v) => !verified.includes(v));
    return remaining.length > 0 ? `awaiting ${remaining.join(' & ')}` : 'awaiting a verification';
  }
  return WAITING_TEXT[step.stepId] ?? 'awaiting the next step';
}

function phaseFor(step: WizardStep, facts: ContributionFacts, entry: ContributionMirrorEntry, feedEvents: FeedEvent[]): LifecyclePhase {
  const mayAct = step.state === 'current'
    && Object.values(step.roles).some((r) => r?.mayAct);
  const phase: LifecyclePhase = {
    stepId: step.stepId,
    title: step.title,
    state: step.state,
    progress: { done: step.progress.done, required: step.progress.required },
    mayAct,
    waitingOn: step.state === 'current' && !mayAct ? waitingText(step, facts, entry) : undefined,
    // note rides DONE phases only (the spec scopes the verdict display there;
    // a partial all-parties verify shows its own progress, not the first
    // check's reason).
    note: step.state === 'complete' && step.stepId === 'verify' && entry.verdictReason ? entry.verdictReason : undefined,
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
    // In readOnly mode outcome is always 'pending' (unknown registers) — the
    // page's terminal banner must gate on readOnly, never on outcome.
    outcome: wm.outcome,
    appealed: wm.appealed ?? false,
    readOnly: wm.readOnly,
    phases: wm.steps.map((s) => phaseFor(s, facts, entry, feedEvents)),
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