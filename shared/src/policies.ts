export const VOTE_THRESHOLD = 2;

export const TOKEN_CONFIG: import('./types').TokenConfig = {
  initialTokens: 20,
  distributionRate: 20,
  distributionIntervalMs: 30 * 1000, // 30 seconds for the demo
  defaultExpiryMs: 60 * 1000, // 1 minute for the demo
};

export const POLICIES = {
  create_proposal: 'role:member',
  vote: 'role:member',
  execute: 'role:member',
  add_member: 'role:member',
} as const;

export const STATE_NAMES = {
  members: 'members',
  proposals: 'proposals',
  executedProposals: 'executed',
} as const;

export const TOKEN_NAMES = {
  balance: (username: string) => `tokens:${username}`,
  lastDistribution: (username: string) => `tokens:${username}:last_dist`,
  proposalMirrorSet: (proposalId: string) => `tokens:${proposalId}:mirror`,
  proposalMirrorElement: (proposalId: string, username: string, n: number) => `tokens:${proposalId}:${username}:${n}`,
  voteTypeSet: (proposalId: string) => `votes:${proposalId}:voters`,
  proposalType: (proposalId: string) => `proposals:${proposalId}:type`,
  proposalExpiresAt: (proposalId: string) => `proposals:${proposalId}:expires`,
  proposalExecuted: (proposalId: string) => `proposals:${proposalId}:executed`,
  proposalPassed: (proposalId: string) => `proposals:${proposalId}:passed`,
  proposalWinner: (proposalId: string) => `proposals:${proposalId}:winner`,
  proposalOptionCount: (proposalId: string) => `proposals:${proposalId}:option_count`,
  optionVoteSet: (proposalId: string, index: number) => `votes:${proposalId}:opt${index}`,
  optionVoteCount: (proposalId: string, index: number) => `votes:${proposalId}:opt${index}_count`,
} as const;
