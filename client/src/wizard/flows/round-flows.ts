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
