export const VOTE_THRESHOLD = 2;

// $RES — the transferable token paid only when a class-specific outcome rule
// fires. No time-based accrual: balances only move through verified
// contributions.
export const RES_CONFIG = {
  verificationCheckCredit: 2, // C_18 Moon: per completed check, either direction
  buildingBounty: 12,         // C_1 Magician: delivery bounty on acceptance
  recordingBaseCredit: 3,     // C_2 Priestess: base credit on accepted record
} as const;

export const TIMING: { defaultExpiryMs: number } = {
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
  submit_contribution: 'role:member',
  verify_contribution: 'role:member',
} as const;

export const STATE_NAMES = {
  members: 'members',
  proposals: 'proposals',
  executedProposals: 'executed',
  contributions: 'contributions',
} as const;

export const TOKEN_NAMES = {
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

export const RES_NAMES = {
  balance: (username: string) => `res:${username}`,
} as const;

export const CONTRIB_NAMES = {
  // Contribution status register: 0 = pending, 1 = accepted, 2 = rejected.
  status: (contributionId: string) => `contrib:${contributionId}:st`,
  // ORSet holding one JSON explanation record per decision (submit, verify).
  explanations: (contributionId: string) => `contrib:${contributionId}:e`,
  // Per-member 22-dimension tally register (absence-of-delta = never set).
  dimensionBalance: (username: string, dimIndex: number) => `dim:${username}:c${dimIndex}`,
} as const;

export const CUSTODIAN_SEATS = 5;
export const RUNOFF_SUFFIX = ':runoff';
export const runoffId = (electionId: string) => `${electionId}${RUNOFF_SUFFIX}`;

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
