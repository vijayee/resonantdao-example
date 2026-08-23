import { Node, KeyPair, Operation } from 'crabs-wasm';
import { POLICIES, STATE_NAMES, VOTE_THRESHOLD } from '../../shared/src/policies';
import { AddMemberPayload, ExecutePayload, ProposalPayload, VotePayload } from '../../shared/src/types';

const ADMIN_ID = 'admin';

export class DaoNode {
  node!: Node;
  private nodeKey!: KeyPair;

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
      // Remove any prior vote from this signer and adjust counters
      if (state.setContains(`${voteSet}:yes`, `${op.signerId}:yes`)) {
        state.setRemove(`${voteSet}:yes`, `${op.signerId}:yes`);
        state.decrementPNCounter(`${voteSet}:yes_count`, 1, op.signerId);
      }
      if (state.setContains(`${voteSet}:no`, `${op.signerId}:no`)) {
        state.setRemove(`${voteSet}:no`, `${op.signerId}:no`);
        state.decrementPNCounter(`${voteSet}:no_count`, 1, op.signerId);
      }
      // Add current vote
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
  }

  registerMember(username: string, publicKeyHex: string): number {
    // Initial attributes cannot contain privileged names such as "role";
    // register the user with no initial attributes, then grant roles via admin ops.
    // registerUser sets key_version to 1; each grantRole bumps it by 1.
    this.node.registerUser(username, publicKeyHex);
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    this.node.grantRole(username, 'reputation', '1', ADMIN_ID);
    return 3;
  }

  getUserKeyVersion(username: string): number {
    // For this PoC the server is the only source of attribute changes, so it
    // can return the fixed post-registration version. If attributes ever change
    // at runtime, this should be derived from the actual CRABS state.
    return this.isMember(username) ? 3 : 0;
  }

  async createAdminOperation(type: string, payload: object): Promise<Operation> {
    const op = await Operation.create(type);
    op.signerId = ADMIN_ID;
    op.nodeId = 'server';
    op.payload = JSON.stringify(payload);
    this.node.sign(op, this.nodeKey);
    return op;
  }

  executeOperation(op: Operation) {
    this.node.execute(op);
  }

  async deserializeOperation(bytes: Uint8Array): Promise<Operation> {
    return await Operation.deserialize(bytes);
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
}
