import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { AddMemberPayload, CastBallotPayload, ExecutePayload, FinalizeElectionPayload, ProposalPayload, ProposalType, StartElectionPayload, VotePayload } from './types';
import {
  CONFIG_NAMES, CUSTODIAN_SEATS, ELECTION_NAMES, RUNOFF_SUFFIX, runoffId, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES, VOTE_THRESHOLD,
} from './policies';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isValidProposalType(value: unknown): value is ProposalType {
  return value === 'direct' || value === 'quadratic';
}

function isValidOptions(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 10 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

export function makeAddMemberHandler() {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: AddMemberPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.username) || !isNonEmptyString(payload.publicKeyHex)) {
      return -1;
    }
    state.setAdd(STATE_NAMES.members, payload.username, payload.publicKeyHex);
    return 0;
  };
}

export function makeCreateProposalHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void; addOneShotSet(name: string): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ProposalPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.proposalId) ||
      !isNonEmptyString(payload.title) ||
      !isValidProposalType(payload.proposalType) ||
      !isValidOptions(payload.options)
    ) {
      return -1;
    }

    const optionCount = payload.options.length;
    try { node.addRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    for (let i = 0; i < optionCount; i++) {
      try { node.addORSet(TOKEN_NAMES.optionVoteSet(payload.proposalId, i)); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
      try { node.addPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, i)); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
    }
    try { node.addOneShotSet(TOKEN_NAMES.voteTypeSet(payload.proposalId)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(TOKEN_NAMES.proposalMirrorSet(payload.proposalId)); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalType(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalExecuted(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalPassed(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalWinner(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = typeof payload.expiresAt === 'number' && payload.expiresAt > nowMs ? payload.expiresAt : nowMs + TOKEN_CONFIG.defaultExpiryMs;

    state.setRegister(TOKEN_NAMES.proposalType(payload.proposalId), payload.proposalType === 'direct' ? 1 : 2, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId), expiresAt, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId), optionCount, op.signerId);
    state.setAdd(STATE_NAMES.proposals, payload.proposalId, JSON.stringify(payload));
    return 0;
  };
}

function distributeTokens(state: HandlerState, username: string, nowMs: number): number {
  const balanceReg = TOKEN_NAMES.balance(username);
  const lastDistReg = TOKEN_NAMES.lastDistribution(username);
  let balance = state.getRegister(balanceReg) || 0;
  let lastDist = state.getRegister(lastDistReg) || 0;

  if (lastDist === 0) {
    // Registers are initialized at user registration; if missing, fall back to 0.
    return balance;
  }

  const interval = state.getRegister(CONFIG_NAMES.distributionInterval()) || TOKEN_CONFIG.distributionIntervalMs;
  const rate = state.getRegister(CONFIG_NAMES.distributionRate()) || TOKEN_CONFIG.distributionRate;
  const elapsed = nowMs - lastDist;
  const intervals = Math.floor(elapsed / interval);
  if (intervals > 0) {
    balance += intervals * rate;
    lastDist += intervals * interval;
    state.setRegister(balanceReg, balance, 'system');
    state.setRegister(lastDistReg, lastDist, 'system');
  }
  return balance;
}

export function makeVoteHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: VotePayload = JSON.parse(op.payload || '{}');
    const optionCount = state.getRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId)) || 0;
    if (
      !isNonEmptyString(payload.proposalId) ||
      optionCount <= 0 ||
      !Number.isInteger(payload.choice) ||
      payload.choice < 0 ||
      payload.choice >= optionCount
    ) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();

    const proposalTypeReg = TOKEN_NAMES.proposalType(payload.proposalId);
    const expiresAtReg = TOKEN_NAMES.proposalExpiresAt(payload.proposalId);
    const proposalType = state.getRegister(proposalTypeReg) || 1;
    const expiresAt = state.getRegister(expiresAtReg) || 0;

    if (expiresAt > 0 && nowMs > expiresAt) {
      return -1;
    }

    // Direct vote: state machine rejects duplicate votes per user per proposal.
    let voteNumber = 1;
    if (proposalType === 1) {
      const votersSet = TOKEN_NAMES.voteTypeSet(payload.proposalId);
      if (state.setContains(votersSet, op.signerId)) {
        return -1;
      }
      state.setAdd(votersSet, op.signerId, op.signerId);
    }

    // Quadratic vote: allow multiple votes. Each additional vote costs n^2
    // tokens from a mirrored per-proposal token pool. Tokens are not globally
    // consumed; the mirror tracks the cumulative cost spent on this proposal.
    if (proposalType === 2) {
      const balance = distributeTokens(state, op.signerId, nowMs);
      const mirrorSet = TOKEN_NAMES.proposalMirrorSet(payload.proposalId);
      let used = 0;
      const maxVoteCheck = 100;
      for (let i = 1; i <= maxVoteCheck; i++) {
        const el = TOKEN_NAMES.proposalMirrorElement(payload.proposalId, op.signerId, i);
        if (state.setContains(mirrorSet, el)) {
          used = i;
        } else {
          break;
        }
      }
      voteNumber = used + 1;
      // Cumulative quadratic cost after voteNumber votes: sum_{i=1}^{voteNumber} i^2
      const cumulativeCost = (voteNumber * (voteNumber + 1) * (2 * voteNumber + 1)) / 6;
      if (balance < cumulativeCost) {
        return -1;
      }
      state.setAdd(mirrorSet, TOKEN_NAMES.proposalMirrorElement(payload.proposalId, op.signerId, voteNumber), `${op.signerId}:${voteNumber}`);
    }

    const voteKey = `${op.signerId}:${voteNumber}`;
    state.setAdd(TOKEN_NAMES.optionVoteSet(payload.proposalId, payload.choice), voteKey, op.signerId);
    state.incrementPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, payload.choice), 1, op.signerId);
    return 0;
  };
}

export function makeExecuteHandler(
  config: { getTimeMs?: () => number; threshold?: number } = {}
) {
  const threshold = config.threshold ?? VOTE_THRESHOLD;
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ExecutePayload = JSON.parse(op.payload || '{}');
    const optionCount = state.getRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId)) || 0;
    if (!isNonEmptyString(payload.proposalId) || optionCount <= 0) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId)) || 0;

    let leaderIdx = 0;
    let leaderCount = 0;
    let total = 0;
    for (let i = 0; i < optionCount; i++) {
      const count = state.getPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, i)) || 0;
      total += count;
      if (count > leaderCount) {
        leaderCount = count;
        leaderIdx = i;
      }
    }
    const hasMajority = total > 0 && leaderCount * 2 > total;

    if (expiresAt > 0 && nowMs < expiresAt) {
      // Before expiry, only auto-execute if the leader reached the vote
      // threshold AND already holds a strict majority of votes cast so far.
      if (!(leaderCount >= threshold && hasMajority)) {
        return 0;
      }
    }

    state.setRegister(TOKEN_NAMES.proposalPassed(payload.proposalId), hasMajority ? 1 : 0, op.signerId);
    // Register stores winnerIndex + 1; 0 = no winner (avoids a negative
    // register initial value, which the CRABS WASM wrapper does not guarantee).
    state.setRegister(TOKEN_NAMES.proposalWinner(payload.proposalId), hasMajority ? leaderIdx + 1 : 0, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalExecuted(payload.proposalId), 1, op.signerId);
    state.setAdd(STATE_NAMES.executedProposals, payload.proposalId, op.signerId);
    return 0;
  };
}

export function makeStartElectionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: StartElectionPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (
      !isNonEmptyString(id) ||
      !Array.isArray(payload.candidates) ||
      payload.candidates.length === 0 ||
      payload.candidates.length > 50 ||
      !payload.candidates.every(isNonEmptyString) ||
      new Set(payload.candidates).size !== payload.candidates.length
    ) {
      return -1;
    }
    for (const candidate of payload.candidates) {
      if (!state.setContains(STATE_NAMES.members, candidate)) {
        return -1;
      }
    }

    try {
      node.addORSet(ELECTION_NAMES.ballots(id));
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('duplicate_operation')) {
        return -1; // election id already in use
      }
      console.warn('start_election resource init warning:', err);
    }
    try { node.addORSet(ELECTION_NAMES.candidates(id)); } catch (err) { console.warn('start_election resource init warning:', err); }
    for (const candidate of payload.candidates) {
      try { node.addPNCounter(ELECTION_NAMES.candVotes(id, candidate)); } catch (err) { console.warn('start_election resource init warning:', err); }
      state.setAdd(ELECTION_NAMES.candidates(id), candidate, op.signerId);
    }
    try { node.addRegister(ELECTION_NAMES.expires(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.finalized(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.isRunoff(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.seats(id), 0); } catch (err) { /* ignore duplicate */ }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = typeof payload.expiresAt === 'number' && payload.expiresAt > nowMs
      ? payload.expiresAt
      : nowMs + TOKEN_CONFIG.defaultExpiryMs;

    state.setRegister(ELECTION_NAMES.expires(id), expiresAt, op.signerId);
    state.setRegister(ELECTION_NAMES.finalized(id), 0, op.signerId);
    state.setRegister(ELECTION_NAMES.isRunoff(id), 0, op.signerId);
    state.setRegister(ELECTION_NAMES.seats(id), CUSTODIAN_SEATS, op.signerId);
    return 0;
  };
}

export function makeCastBallotHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: CastBallotPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (!isNonEmptyString(id) || !Array.isArray(payload.picks)) {
      return -1;
    }
    if (payload.picks.length < 1 || payload.picks.length > CUSTODIAN_SEATS) {
      return -1;
    }
    if (!payload.picks.every(isNonEmptyString) || new Set(payload.picks).size !== payload.picks.length) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0 || nowMs > expiresAt) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.finalized(id)) === 1) {
      return -1;
    }

    const ballots = ELECTION_NAMES.ballots(id);
    if (state.setContains(ballots, op.signerId)) {
      return -1; // one ballot per voter
    }

    for (const pick of payload.picks) {
      if (!state.setContains(ELECTION_NAMES.candidates(id), pick)) {
        return -1;
      }
    }

    state.setAdd(ballots, op.signerId, op.signerId);
    for (const pick of payload.picks) {
      state.incrementPNCounter(ELECTION_NAMES.candVotes(id, pick), 1, op.signerId);
    }
    return 0;
  };
}

// Shared ranking used by the finalize handler, the server's custodian grant
// flow, and the client's election mirroring so all three compute identical
// results. Ties sort alphabetically. Zero-vote candidates never win.
export function rankCandidates(
  candidates: string[],
  getVotes: (candidate: string) => number,
  seats: number,
  allowRunoff: boolean
): { winners: string[]; runoffCandidates: string[]; runoffSeats: number } {
  if (!Number.isInteger(seats) || seats <= 0) {
    return { winners: [], runoffCandidates: [], runoffSeats: 0 };
  }

  const ranked = candidates
    .map((candidate) => ({ candidate, votes: getVotes(candidate) }))
    .filter((entry) => entry.votes > 0)
    .sort((a, b) => b.votes - a.votes || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0));

  if (ranked.length <= seats) {
    return { winners: ranked.map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  const cutoffVotes = ranked[seats].votes;
  if (ranked[seats - 1].votes !== cutoffVotes) {
    return { winners: ranked.slice(0, seats).map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  if (!allowRunoff) {
    // Runoff deadlock guard: alphabetical order already applied by the sort.
    return { winners: ranked.slice(0, seats).map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  const clear = ranked.filter((e) => e.votes > cutoffVotes).map((e) => e.candidate);
  const tied = ranked.filter((e) => e.votes === cutoffVotes).map((e) => e.candidate);
  return { winners: clear, runoffCandidates: tied, runoffSeats: seats - clear.length };
}

// PoC limitation: a spawned runoff stays pending (parent finalized=2) until a
// member calls finalize_election on the runoff after its expiry. The client UI
// always offers this action once the runoff expires.
export function makeFinalizeElectionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: FinalizeElectionPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (
      !isNonEmptyString(id) ||
      !Array.isArray(payload.candidates) ||
      !payload.candidates.every(isNonEmptyString) ||
      new Set(payload.candidates).size !== payload.candidates.length
    ) {
      return -1;
    }
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0) {
      return -1;
    }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    if (nowMs < expiresAt) {
      return 0; // not expired yet; no-op
    }
    const finalized = state.getRegister(ELECTION_NAMES.finalized(id));
    if (finalized === 1 || finalized === 2) {
      return 0; // idempotent
    }
    const isRunoff = state.getRegister(ELECTION_NAMES.isRunoff(id)) === 1;
    const seats = state.getRegister(ELECTION_NAMES.seats(id)) || 0;
    if (seats <= 0) {
      return -1;
    }
    for (const candidate of payload.candidates) {
      if (!state.setContains(ELECTION_NAMES.candidates(id), candidate)) {
        return -1;
      }
    }

    const getVotes = (candidate: string) => state.getPNCounter(ELECTION_NAMES.candVotes(id, candidate)) || 0;
    const result = rankCandidates(payload.candidates, getVotes, seats, !isRunoff);

    try { node.addORSet(ELECTION_NAMES.winners(id)); } catch (err) { console.warn('finalize resource init warning:', err); }
    for (const winner of result.winners) {
      state.setAdd(ELECTION_NAMES.winners(id), winner, op.signerId);
    }

    if (result.runoffCandidates.length > 0) {
      const rid = runoffId(id);
      try { node.addORSet(ELECTION_NAMES.ballots(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      try { node.addORSet(ELECTION_NAMES.candidates(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      try { node.addORSet(ELECTION_NAMES.mirrorSet(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      for (const candidate of result.runoffCandidates) {
        try { node.addPNCounter(ELECTION_NAMES.candVotes(rid, candidate)); } catch (err) { console.warn('finalize resource init warning:', err); }
        state.setAdd(ELECTION_NAMES.candidates(rid), candidate, op.signerId);
      }
      try { node.addRegister(ELECTION_NAMES.expires(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.finalized(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.isRunoff(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.seats(rid), 0); } catch (err) { /* ignore duplicate */ }

      state.setRegister(ELECTION_NAMES.expires(rid), nowMs + TOKEN_CONFIG.defaultExpiryMs, op.signerId);
      state.setRegister(ELECTION_NAMES.isRunoff(rid), 1, op.signerId);
      state.setRegister(ELECTION_NAMES.seats(rid), result.runoffSeats, op.signerId);
      state.setRegister(ELECTION_NAMES.finalized(id), 2, op.signerId); // awaiting runoff
      return 0;
    }

    if (isRunoff) {
      const parentId = id.slice(0, -RUNOFF_SUFFIX.length);
      try { node.addORSet(ELECTION_NAMES.winners(parentId)); } catch (err) { console.warn('finalize resource init warning:', err); }
      for (const winner of result.winners) {
        state.setAdd(ELECTION_NAMES.winners(parentId), winner, op.signerId);
      }
      state.setRegister(ELECTION_NAMES.finalized(parentId), 1, op.signerId);
    }
    state.setRegister(ELECTION_NAMES.finalized(id), 1, op.signerId);
    return 0;
  };
}
