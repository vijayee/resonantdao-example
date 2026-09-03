import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { AddMemberPayload, ExecutePayload, ProposalPayload, ProposalType, VotePayload } from './types';
import { CONFIG_NAMES, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES, VOTE_THRESHOLD } from './policies';

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
