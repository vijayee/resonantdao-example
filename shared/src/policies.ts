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
  start_election: 'role:member',
  cast_ballot: 'role:member',
  finalize_election: 'role:member',
  cast_runoff_vote: 'role:member',
  set_token_config: 'role:custodian',
  remove_member: 'role:custodian',
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

export const CUSTODIAN_SEATS = 5;
export const RUNOFF_SUFFIX = ':runoff';
export const runoffId = (electionId: string) => `${electionId}${RUNOFF_SUFFIX}`;

export const CONFIG_NAMES = {
  distributionInterval: () => 'config:distribution_interval',
  distributionRate: () => 'config:distribution_rate',
} as const;

export const ELECTION_NAMES = {
  // Keep resource names under CRABS' 63-character key limit. A full UUID (36
  // chars) plus verbose prefix/candidate pushes candidate-vote counters over
  // the limit, so use single-letter delimiters.
  //
  // Worst-case lengths with a 36-char UUID id:
  //   e:{id}:v:{username}      -> 41 + username  (max username 22)
  //   e:{id}:m:{username}:{n} -> 43 + username  (max username 20)
  //   e:{id}:runoff:v:{username} -> 48 + username (max username 15)
  // Demo usernames are short; this is acceptable for the PoC.
  candidates: (id: string) => `e:${id}:c`,
  candVotes: (id: string, username: string) => `e:${id}:v:${username}`,
  ballots: (id: string) => `e:${id}:b`,
  expires: (id: string) => `e:${id}:x`,
  finalized: (id: string) => `e:${id}:f`,
  isRunoff: (id: string) => `e:${id}:r`,
  seats: (id: string) => `e:${id}:s`,
  winners: (id: string) => `e:${id}:w`,
  mirrorSet: (id: string) => `e:${id}:m`,
  mirrorElement: (id: string, username: string, n: number) => `e:${id}:m:${username}:${n}`,
} as const;
