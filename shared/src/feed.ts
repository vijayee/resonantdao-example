import { DIMENSIONS, HarmVerdict } from './contribution';

export type FeedEventType =
  | 'proposal_created' | 'proposal_executed'
  | 'contribution_submitted' | 'contribution_verified'
  | 'contribution_settled' | 'contribution_appealed'
  | 'verifiers_reassigned'
  | 'election_started' | 'election_finalized'
  | 'round_audited' | 'round_reckoned' | 'round_published';

export interface FeedEvent {
  index: number;
  type: FeedEventType;
  actor: string;
  at: number;
  round: number;
  summary: string;
  targetId?: string;
  detail?: {
    proposalType?: 'direct' | 'quadratic';
    verifyPass?: boolean;
    harm?: HarmVerdict;
    fair?: boolean;
    aggregatedCount?: number;
  };
}

// The mirrored-timeline op set — votes are deliberately absent (D2).
export const CONSEQUENTIAL_OPS: ReadonlySet<string> = new Set([
  'create_proposal', 'execute',
  'submit_contribution', 'verify_contribution', 'settle_contribution', 'appeal_verdict',
  'reassign_verifiers',
  'start_election', 'finalize_election',
  'audit_round', 'reckon_round', 'complete_round',
]);

const OP_TO_EVENT: Record<string, FeedEventType> = {
  create_proposal: 'proposal_created',
  execute: 'proposal_executed',
  submit_contribution: 'contribution_submitted',
  verify_contribution: 'contribution_verified',
  settle_contribution: 'contribution_settled',
  appeal_verdict: 'contribution_appealed',
  reassign_verifiers: 'verifiers_reassigned',
  start_election: 'election_started',
  finalize_election: 'election_finalized',
  audit_round: 'round_audited',
  reckon_round: 'round_reckoned',
  complete_round: 'round_published',
};

function dimLabels(dims: Record<string, number>): string[] {
  return Object.keys(dims).map((k) => {
    const def = DIMENSIONS[Number(k)];
    return def ? `${def.cls} (${def.code})` : 'C_?';
  });
}

// Pure projection: one signed op → one FeedEvent (or null for ops the feed
// does not mirror). `currentRound` is round:current AT capture; complete_round
// bumps that register before this runs, so its event belongs to the finishing
// round (same target logic as the dao's round mirror).
export function feedEventFromOp(
  type: string,
  signerId: string,
  payloadJson: string,
  at: number,
  currentRound: number,
  nextIndex: number,
): FeedEvent | null {
  const eventType = OP_TO_EVENT[type];
  if (!eventType) return null;

  let payload: any = {};
  try { payload = JSON.parse(payloadJson.replace(/\0$/, '')); } catch { payload = null; }

  const round = type === 'complete_round' ? currentRound - 1 : currentRound;
  const base: Omit<FeedEvent, 'summary'> = { index: nextIndex, type: eventType, actor: signerId, at, round };

  if (payload === null) {
    // Corrupt/unknown payload on a consequential op: honest generic line.
    return { ...base, summary: `${type.replace(/_/g, ' ')}` };
  }

  switch (type) {
    case 'create_proposal': {
      const proposalType = payload.proposalType === 'quadratic' ? 'quadratic' : 'direct';
      const title = typeof payload.title === 'string' ? payload.title : '';
      return {
        ...base,
        summary: `"${title}" — ${proposalType} proposal created`,
        targetId: typeof payload.proposalId === 'string' ? payload.proposalId : undefined,
        detail: { proposalType },
      };
    }
    case 'execute': {
      const id = typeof payload.proposalId === 'string' ? payload.proposalId : '';
      return { ...base, summary: `proposal ${id.slice(0, 8)} executed`, targetId: id || undefined };
    }
    case 'submit_contribution': {
      const dims = dimLabels(payload.dims ?? {}).join(', ');
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      return {
        ...base,
        summary: `${dims || 'C_?'} contribution submitted — "${summary}"`,
        targetId: typeof payload.contributionId === 'string' ? payload.contributionId : undefined,
      };
    }
    case 'verify_contribution': {
      const submitter = typeof payload.submitter === 'string' ? payload.submitter : '';
      const pass = payload.pass === true;
      const harm = (payload.harm ?? 'none') as HarmVerdict;
      const harmNote = harm !== 'none' && pass ? ` (${harm})` : '';
      return {
        ...base,
        summary: `${signerId} verified ${submitter} — ${pass ? 'upheld' : 'no'}${harmNote}`,
        targetId: typeof payload.contributionId === 'string' ? payload.contributionId : undefined,
        detail: { verifyPass: pass, harm },
      };
    }
    case 'settle_contribution':
      return { ...base, summary: `${payload.submitter ?? ''} settled`.trim(),
        targetId: typeof payload.contributionId === 'string' ? payload.contributionId : undefined };
    case 'appeal_verdict':
      return { ...base, summary: `${signerId} appealed — awaiting re-verification`,
        targetId: typeof payload.contributionId === 'string' ? payload.contributionId : undefined };
    case 'reassign_verifiers': {
      const names = Array.isArray(payload.verifiers) ? payload.verifiers as string[] : [];
      return {
        ...base,
        summary: `${signerId} named ${names.join(' & ') || 'no-one'} as additional verifier(s)`,
        targetId: typeof payload.contributionId === 'string' ? payload.contributionId : undefined,
      };
    }
    case 'start_election':
      return {
        ...base,
        summary: `custodian election started — ${Array.isArray(payload.candidates) ? payload.candidates.length : 0} candidates`,
        targetId: typeof payload.electionId === 'string' ? payload.electionId : undefined,
      };
    case 'finalize_election':
      return { ...base, summary: 'custodian election finalized',
        targetId: typeof payload.electionId === 'string' ? payload.electionId : undefined };
    case 'audit_round': {
      const fair = payload.fair === true;
      return { ...base, summary: `round ${round} audited — ${fair ? 'fair' : 'closed with debt'}`,
        detail: { fair } };
    }
    case 'reckon_round':
      return { ...base, summary: `round ${round} reckoned — ready to complete` };
    case 'complete_round': {
      const count = Array.isArray(payload.entries) ? payload.entries.length : 0;
      return { ...base, summary: `round ${round} published — ${count} contribution(s) aggregated`,
        detail: { aggregatedCount: count } };
    }
    default:
      return null;
  }
}
