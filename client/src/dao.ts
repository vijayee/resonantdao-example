import { Node, KeyPair, Operation } from './wasm';
import type {
  Node as CRABSNode,
  KeyPair as CRABSKeyPair,
  Operation as CRABSOperation,
} from '/wasm/crabs/index.js';
import { POLICIES, STATE_NAMES } from '@shared/policies';
import { setOperationSignerKeyVersion } from '@shared/crabs-helpers';
import { ProposalPayload, VotePayload, ExecutePayload } from '@shared/types';
import {
  makeAddMemberHandler,
  makeCreateProposalHandler,
  makeVoteHandler,
  makeExecuteHandler,
} from '@shared/handlers';

const ADMIN_ID = 'admin';

export class BrowserDao {
  node!: CRABSNode;
  nodeId = 'browser';
  private signingKey!: CRABSKeyPair;
  private keyVersion = 0;

  async init(username: string, signingSeedHex: string, keyVersion: number) {
    this.nodeId = crypto.randomUUID();
    this.signingKey = await KeyPair.fromPrivateHex(signingSeedHex);
    this.keyVersion = keyVersion;
    this.node = await Node.create(ADMIN_ID, { ordering: 'hlc' });
    this.node.addORSet(STATE_NAMES.members);
    this.node.addORSet(STATE_NAMES.proposals);
    this.node.addORSet(STATE_NAMES.executedProposals);

    this.node.setPolicy('create_proposal', POLICIES.create_proposal);
    this.node.setPolicy('vote', POLICIES.vote);
    this.node.setPolicy('execute', POLICIES.execute);
    this.node.setPolicy('add_member', POLICIES.add_member);

    this.node.registerHandlerJs('add_member', makeAddMemberHandler());
    this.node.registerHandlerJs('create_proposal', makeCreateProposalHandler(this.node));
    this.node.registerHandlerJs('vote', makeVoteHandler());
    this.node.registerHandlerJs('execute', makeExecuteHandler());

    this.node.registerUser(username, this.signingKey.publicKeyHex());
    // PoC bootstrap: the client locally grants its own membership attributes.
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    this.node.grantRole(username, 'reputation', '1', ADMIN_ID);
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

  registerMember(username: string, publicKeyHex: string) {
    if (this.node.getUser(username)?.status === 'active') return;
    this.node.registerUser(username, publicKeyHex);
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    this.node.grantRole(username, 'reputation', '1', ADMIN_ID);
  }

  private async signAndSerialize(type: string, userId: string, payloadJson: string): Promise<Uint8Array> {
    const op = await Operation.create(type);
    op.signerId = userId;
    op.nodeId = this.nodeId;
    // The crabs-wasm handler payload getter expects a null-terminated buffer.
    op.payload = new TextEncoder().encode(payloadJson + '\0');
    setOperationSignerKeyVersion(op, this.keyVersion);
    this.node.sign(op, this.signingKey);
    const bytes = op.serialize();
    op.destroy();
    return bytes;
  }

  private proposals = new Map<string, ProposalPayload>();

  serialize(): Uint8Array {
    return this.node.serialize();
  }

  async executeRemote(bytes: Uint8Array): Promise<void> {
    const op = await Operation.deserialize(bytes);
    try {
      this.node.execute(op);
      const proposal = await this.parseCreateProposal(bytes);
      if (proposal) {
        this.proposals.set(proposal.proposalId, proposal);
      }
    } finally {
      op.destroy();
    }
  }

  private async parseCreateProposal(bytes: Uint8Array): Promise<ProposalPayload | null> {
    const op = await Operation.deserialize(bytes);
    try {
      if (op.type !== 'create_proposal') return null;
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      return JSON.parse(json.replace(/\0$/, '')) as ProposalPayload;
    } catch {
      return null;
    } finally {
      op.destroy();
    }
  }

  getProposals(): ProposalPayload[] {
    return Array.from(this.proposals.values());
  }

  getProposalVotes(id: string): { yes: number; no: number } {
    return {
      yes: this.node.getPNCounter(`votes:${id}:yes_count`) || 0,
      no: this.node.getPNCounter(`votes:${id}:no_count`) || 0,
    };
  }

  isProposalExecuted(id: string): boolean {
    return this.node.setContains(STATE_NAMES.executedProposals, id);
  }

  destroy() {
    try { this.signingKey.destroy(); } catch { /* ignore */ }
    try { this.node.destroy(); } catch { /* ignore */ }
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

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
