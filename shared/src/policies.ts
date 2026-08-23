export const POLICIES = {
  create_proposal: 'role:member',
  vote: 'role:member',
  execute: 'role:member AND votes >= threshold',
  add_member: 'role:member',
} as const;

export const ATTRIBUTES = {
  member: 'role:member',
  reputation: (n: number) => `reputation:${n}`,
  human: 'trust:human',
} as const;

export const STATE_NAMES = {
  members: 'members',
  proposals: 'proposals',
  proposalVotes: (id: string) => `votes:${id}`,
  executedProposals: 'executed',
} as const;
