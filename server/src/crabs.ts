import { Node, KeyPair, Operation } from 'crabs-wasm';
import { POLICIES, STATE_NAMES, VOTE_THRESHOLD } from '../../shared/src/policies';
import { AddMemberPayload, ExecutePayload, ProposalPayload, ServerOperation, VotePayload } from '../../shared/src/types';

const ADMIN_ID = 'admin';

export class DaoNode {
  node!: Node;
  private nodeKey!: KeyPair;
  // The crabs-wasm JS wrapper does not expose user key_version or a setter for
  // operation signer_key_version, but CRABS requires them to match at execute
  // time (R7-04). We track the version ourselves because grantRole increments it.
  private userKeyVersions = new Map<string, number>();

  async init() {
    this.node = await Node.create(ADMIN_ID, { ordering: 'hlc' });
    this.nodeKey = await KeyPair.generate();
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
      // Remove any prior vote from this signer
      state.setRemove(`${voteSet}:yes`, `${op.signerId}:yes`);
      state.setRemove(`${voteSet}:no`, `${op.signerId}:no`);
      // Add current vote
      state.setAdd(`${voteSet}:${payload.vote}`, `${op.signerId}:${payload.vote}`, op.signerId);
      // Maintain counters because set iteration is not exposed
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
  }

  registerMember(username: string, publicKeyHex: string) {
    // Initial attributes cannot contain privileged names such as "role";
    // roles are granted separately by the bootstrap admin.
    this.node.registerUser(username, publicKeyHex, undefined);
    let keyVersion = 1;
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    keyVersion++;
    this.node.grantRole(username, 'reputation', '1', ADMIN_ID);
    keyVersion++;
    this.userKeyVersions.set(username, keyVersion);
  }

  async createSignedOperation(type: string, signerId: string, payload: object, signingKey: KeyPair | string): Promise<Operation> {
    const op = await Operation.create(type);
    op.signerId = signerId;
    op.nodeId = 'server';
    // The crabs-wasm handler payload getter requires a null-terminated buffer,
    // but the Operation payload setter encodes strings without a trailing zero.
    // Append an explicit null byte so handlers can read the payload back.
    const payloadJson = JSON.stringify(payload);
    op.payload = new TextEncoder().encode(payloadJson + '\0');
    // CRABS requires the operation's signer_key_version to match the user's
    // current key_version. The crabs-wasm JS wrapper does not expose a setter,
    // so we patch the field directly in WASM memory before signing.
    const keyVersion = this.userKeyVersions.get(signerId) ?? 0;
    this.setOperationSignerKeyVersion(op, keyVersion);
    this.node.sign(op, signingKey);
    return op;
  }

  private setOperationSignerKeyVersion(op: Operation, version: number): void {
    // Based on the in-memory operation_t layout (WASM32, default alignment):
    // type[64], uuid[16], payload*(4), payload_size(4), payload_format(1),
    // padding(3), resources*(4), resource_count(4), required_state*(4),
    // next_state*(4), lock_claims*(4), lock_claim_count(4), policy[256],
    // signature[64], signer_id[64], padding(4), signer_key_version(8).
    // Therefore signer_key_version is at offset 504.
    const M = (op as any)._M;
    const ptr = (op as any)._ptr;
    if (!M || !ptr) return;
    const offset = 504;
    const addr = ptr + offset;
    const v = BigInt(version);
    M.HEAPU8[addr] = Number(v & BigInt(0xff));
    M.HEAPU8[addr + 1] = Number((v >> BigInt(8)) & BigInt(0xff));
    M.HEAPU8[addr + 2] = Number((v >> BigInt(16)) & BigInt(0xff));
    M.HEAPU8[addr + 3] = Number((v >> BigInt(24)) & BigInt(0xff));
    M.HEAPU8[addr + 4] = Number((v >> BigInt(32)) & BigInt(0xff));
    M.HEAPU8[addr + 5] = Number((v >> BigInt(40)) & BigInt(0xff));
    M.HEAPU8[addr + 6] = Number((v >> BigInt(48)) & BigInt(0xff));
    M.HEAPU8[addr + 7] = Number((v >> BigInt(56)) & BigInt(0xff));
  }

  executeOperation(op: Operation) {
    this.node.execute(op);
  }

  getProposalVotes(proposalId: string): { yes: number; no: number } {
    const setName = `votes:${proposalId}`;
    return {
      yes: this.node.getPNCounter(`${setName}:yes_count`) || 0,
      no: this.node.getPNCounter(`${setName}:no_count`) || 0,
    };
  }

  isMember(username: string): boolean {
    return this.node.getUser(username)?.status === 'active' || false;
  }

  serialize(): Uint8Array {
    return this.node.serialize();
  }

  async deserializeOperation(so: ServerOperation): Promise<Operation> {
    const op = await Operation.create(so.type);
    op.signerId = so.signerId;
    op.nodeId = so.nodeId;
    op.payload = so.payload || undefined;
    return op;
  }
}
