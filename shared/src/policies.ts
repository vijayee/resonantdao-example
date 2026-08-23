export const VOTE_THRESHOLD = 2;

export const POLICIES = {
  create_proposal: 'role:member',
  vote: 'role:member',
  execute: `role:member AND votes >= ${VOTE_THRESHOLD}`,
  add_member: 'role:member',
} as const;

export const STATE_NAMES = {
  members: 'members',
  proposals: 'proposals',
  proposalVotes: (id: string) => `votes:${id}`,
  executedProposals: 'executed',
} as const;
