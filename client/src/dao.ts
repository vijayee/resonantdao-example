import {
  Node as CRABSNode,
  KeyPair as CRABSKeyPair,
  Operation as CRABSOperation,
} from './wasm';
import type { Node, KeyPair, Operation } from '/wasm/crabs/index.js';
import { POLICIES, STATE_NAMES, VOTE_THRESHOLD } from '@shared/policies';
import { setOperationSignerKeyVersion } from '@shared/crabs-helpers';
import { AddMemberPayload, ExecutePayload, ProposalPayload, VotePayload } from '@shared/types';

type CRABSNode = Node;
type CRABSKeyPair = KeyPair;
type CRABSOperation = Operation;

const ADMIN_ID = 'admin';

export class BrowserDao {
  node!: CRABSNode;
  private signingKey!: CRABSKeyPair;
  private keyVersion = 0;

  async init(signingSeedHex: string, attributeMachine: string, keyVersion: number) {
    this.signingKey = await CRABSKeyPair.fromPrivateHex(signingSeedHex);
    this.keyVersion = keyVersion;
    this.node = await CRABSNode.create(ADMIN_ID, { ordering: 'hlc' });
    this.node.addORSet(STATE_NAMES.members);
    this.node.addORSet(STATE_NAMES.proposals);
    this.node.addOneShotFlag(STATE_NAMES.executedProposals);

    this.node.setPolicy('create_proposal', POLICIES.create_proposal);
    this.node.setPolicy('vote', POLICIES.vote);
    this.node.setPolicy('execute', POLICIES.execute);
    this.node.setPolicy('add_member', POLICIES.add_member);

    this.node.registerHandlerJs('add_member', (state, op) => {
      const payload: AddMemberPayload = JSON.parse(op.payload || '{}');
      state.setAdd(STATE_NAMES.members, payload.username, payload.publicKeyHex);
      return 0;
    });

    this.node.registerHandlerJs('create_proposal', (state, op) => {
      const payload: ProposalPayload = JSON.parse(op.payload || '{}');
      state.setAdd(STATE_NAMES.proposals, payload.proposalId, JSON.stringify(payload));
      return 0;
    });

    this.node.registerHandlerJs('vote', (state, op) => {
      const payload: VotePayload = JSON.parse(op.payload || '{}');
      const voteSet = `votes:${payload.proposalId}`;
      if (state.setContains(`${voteSet}:yes`, `${op.signerId}:yes`)) {
        state.setRemove(`${voteSet}:yes`, `${op.signerId}:yes`);
        state.decrementPNCounter(`${voteSet}:yes_count`, 1, op.signerId);
      }
      if (state.setContains(`${voteSet}:no`, `${op.signerId}:no`)) {
        state.setRemove(`${voteSet}:no`, `${op.signerId}:no`);
        state.decrementPNCounter(`${voteSet}:no_count`, 1, op.signerId);
      }
      state.setAdd(`${voteSet}:${payload.vote}`, `${op.signerId}:${payload.vote}`, op.signerId);
      if (payload.vote === 'yes') state.incrementPNCounter(`${voteSet}:yes_count`, 1, op.signerId);
      else state.incrementPNCounter(`${voteSet}:no_count`, 1, op.signerId);
      return 0;
    });

    this.node.registerHandlerJs('execute', (state, op) => {
      const payload: ExecutePayload = JSON.parse(op.payload || '{}');
      const voteSet = `votes:${payload.proposalId}`;
      const yes = state.getPNCounter(`${voteSet}:yes_count`) || 0;
      if (yes >= VOTE_THRESHOLD) {
        state.flagSet(STATE_NAMES.executedProposals, payload.proposalId);
      }
      return 0;
    });

    this.node.registerUser('self', this.signingKey.publicKeyHex(), attributeMachine);
  }

  async createProposal(userId: string, payload: ProposalPayload): Promise<Uint8Array> {
    return this.signAndSerialize('create_proposal', userId, JSON.stringify(payload));
  }

  async vote(userId: string, payload: VotePayload): Promise<Uint8Array> {
    return this.signAndSerialize('vote', userId, JSON.stringify(payload));
  }

  async execute(userId: string, payload: ExecutePayload): Promise<Uint8Array> {
    return this.signAndSerialize('execute', userId, JSON.stringify(payload));
  }

  private async signAndSerialize(type: string, userId: string, payloadJson: string): Promise<Uint8Array> {
    const op = await CRABSOperation.create(type);
    op.signerId = userId;
    op.nodeId = 'browser';
    // The crabs-wasm handler payload getter expects a null-terminated buffer.
    op.payload = new TextEncoder().encode(payloadJson + '\0');
    setOperationSignerKeyVersion(op, this.keyVersion);
    this.node.sign(op, this.signingKey);
    const bytes = op.serialize();
    this.node.execute(op);
    op.destroy();
    return bytes;
  }

  serialize(): Uint8Array {
    return this.node.serialize();
  }

  async loadState(bytes: Uint8Array) {
    // CRABS WASM does not expose a deserialize method in the high-level wrapper.
    // In this PoC, the client reconstructs state by replaying the operation log from the server.
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(result);
}
