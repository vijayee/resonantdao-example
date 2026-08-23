import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { AddMemberPayload, ExecutePayload, ProposalPayload, VotePayload } from './types';
import { STATE_NAMES, VOTE_THRESHOLD } from './policies';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
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

export function makeCreateProposalHandler(node: { addORSet(name: string): void; addPNCounter(name: string): void }) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ProposalPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.proposalId) || !isNonEmptyString(payload.title)) {
      return -1;
    }
    const voteSet = `votes:${payload.proposalId}`;
    try { node.addORSet(`${voteSet}:yes`); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
    try { node.addORSet(`${voteSet}:no`); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
    try { node.addPNCounter(`${voteSet}:yes_count`); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
    try { node.addPNCounter(`${voteSet}:no_count`); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
    state.setAdd(STATE_NAMES.proposals, payload.proposalId, JSON.stringify(payload));
    return 0;
  };
}

export function makeVoteHandler() {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: VotePayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.proposalId) || (payload.vote !== 'yes' && payload.vote !== 'no')) {
      return -1;
    }
    const voteSet = `votes:${payload.proposalId}`;
    const yesKey = `${op.signerId}:yes`;
    const noKey = `${op.signerId}:no`;

    if (
      (payload.vote === 'yes' && state.setContains(`${voteSet}:yes`, yesKey)) ||
      (payload.vote === 'no' && state.setContains(`${voteSet}:no`, noKey))
    ) {
      return 0;
    }

    if (state.setContains(`${voteSet}:yes`, yesKey)) {
      state.setRemove(`${voteSet}:yes`, yesKey);
      state.decrementPNCounter(`${voteSet}:yes_count`, 1, op.signerId);
    }
    if (state.setContains(`${voteSet}:no`, noKey)) {
      state.setRemove(`${voteSet}:no`, noKey);
      state.decrementPNCounter(`${voteSet}:no_count`, 1, op.signerId);
    }

    state.setAdd(`${voteSet}:${payload.vote}`, `${op.signerId}:${payload.vote}`, op.signerId);
    if (payload.vote === 'yes') {
      state.incrementPNCounter(`${voteSet}:yes_count`, 1, op.signerId);
    } else {
      state.incrementPNCounter(`${voteSet}:no_count`, 1, op.signerId);
    }
    return 0;
  };
}

export function makeExecuteHandler() {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ExecutePayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.proposalId)) {
      return -1;
    }
    const voteSet = `votes:${payload.proposalId}`;
    const yes = state.getPNCounter(`${voteSet}:yes_count`) || 0;
    if (yes >= VOTE_THRESHOLD) {
      state.setAdd(STATE_NAMES.executedProposals, payload.proposalId, op.signerId);
    }
    return 0;
  };
}
