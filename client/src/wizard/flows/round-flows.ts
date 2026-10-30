import { STAGE_AUDITED, STAGE_OPEN, STAGE_RECKONED } from '@shared/round';
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

// Zero-input publish: the review step IS the aggregation preview. The old
// UI's snap-error ('Nothing settled to aggregate') becomes displayed state —
// visible in the summary before anyone confirms.
export function publishFlow(round: number): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'publish',
    title: `Publish round ${round}`,
    steps: [{ kind: 'review' }],
    reviewSummary: () => {
      void ds.tick;
      const d = ds.dao;
      if (!d) return ['(no dao state yet)'];
      const accepted = d.getContributions().filter(
        (e) => d.getContributionStatus(e.record.contributionId) === 'accepted'
          && d.getContributionRound(e.record.contributionId) === round,
      );
      const lines = [`Aggregating ${accepted.length} accepted contribution(s) from round ${round}.`];
      if (accepted.length === 0) lines.push('Nothing settled to aggregate — publishing records an empty round.');
      return lines;
    },
    submit: async () => {
      const ok = await ds.completeRound();
      if (!ok) throw new Error('The round did not publish — check the message below the page.');
    },
  };
}

// The /round page hosts ONE always-present wizard; the round's stage selects
// which flow it renders. No activeFlow state exists — stage and round changes
// remount via the instance key the page computes (stale-initial insurance).
export function stageFlowFor(stage: number, round: number): FlowDefinition | null {
  if (stage === STAGE_OPEN) return auditFlow(round);
  if (stage === STAGE_AUDITED) return reckonFlow(round);
  if (stage === STAGE_RECKONED) return publishFlow(round);
  return null;
}
