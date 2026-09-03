import { Node, KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
import { CONFIG_NAMES, POLICIES, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES } from '../../shared/src/policies';
import {
  makeAddMemberHandler,
  makeCreateProposalHandler,
  makeVoteHandler,
  makeExecuteHandler,
} from '../../shared/src/handlers';

const ADMIN_ID = 'admin';

export class DaoNode {
  node!: Node;
  private nodeKey!: KeyPair;

  async init() {
    this.node = await Node.create(ADMIN_ID, { ordering: 'hlc' });
    this.nodeKey = await KeyPair.generate();
    this.node.addORSet(STATE_NAMES.members);
    this.node.addORSet(STATE_NAMES.proposals);
    this.node.addORSet(STATE_NAMES.executedProposals);
    this.node.addRegister('time_now', 0);
    this.node.addRegister(CONFIG_NAMES.distributionInterval(), 0);
    this.node.addRegister(CONFIG_NAMES.distributionRate(), 0);

    this.node.setPolicy('create_proposal', POLICIES.create_proposal);
    this.node.setPolicy('vote', POLICIES.vote);
    this.node.setPolicy('execute', POLICIES.execute);
    this.node.setPolicy('add_member', POLICIES.add_member);

    this.node.registerHandlerJs('add_member', makeAddMemberHandler());
    this.node.registerHandlerJs('create_proposal', makeCreateProposalHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('vote', makeVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('execute', makeExecuteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
  }

  registerMember(username: string, publicKeyHex: string): number {
    // Initial attributes cannot contain privileged names such as "role";
    // register the user with no initial attributes, then grant roles via admin ops.
    // registerUser sets key_version to 1; each grantRole bumps it by 1.
    //
    // PoC note: clients bootstrap their local membership state from the
    // attributeMachine the server returns at registration. A production system
    // should replay server-signed membership operations from the canonical log
    // instead of trusting a string summary.
    this.node.registerUser(username, publicKeyHex);
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    this.node.grantRole(username, 'reputation', '1', ADMIN_ID);
    this.initTokenRegisters(username);
    return 3;
  }

  private initTokenRegisters(username: string) {
    try { this.node.addRegister(TOKEN_NAMES.balance(username), TOKEN_CONFIG.initialTokens); } catch (err) { /* ignore duplicate */ }
    try { this.node.addRegister(TOKEN_NAMES.lastDistribution(username), Date.now()); } catch (err) { /* ignore duplicate */ }
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
    op.payload = new TextEncoder().encode(JSON.stringify(payload) + '\0');
    setOperationSignerKeyVersion(op, 1);
    this.node.sign(op, this.nodeKey);
    return op;
  }

  executeOperation(op: Operation) {
    try {
      this.node.execute(op);
    } finally {
      op.destroy();
    }
  }

  async deserializeOperation(bytes: Uint8Array): Promise<Operation> {
    return await Operation.deserialize(bytes);
  }

  getProposalOptionVotes(proposalId: string): number[] {
    const optionCount = this.node.getRegister(TOKEN_NAMES.proposalOptionCount(proposalId)) || 0;
    const counts: number[] = [];
    for (let i = 0; i < optionCount; i++) {
      counts.push(this.node.getPNCounter(TOKEN_NAMES.optionVoteCount(proposalId, i)) || 0);
    }
    return counts;
  }

  isMember(username: string): boolean {
    return this.node.getUser(username)?.status === 'active' || false;
  }

  getTokenBalance(username: string): number {
    return this.node.getRegister(TOKEN_NAMES.balance(username)) || 0;
  }

  isProposalExecuted(id: string): boolean {
    return this.node.setContains(STATE_NAMES.executedProposals, id);
  }

  serialize(): Uint8Array {
    return this.node.serialize();
  }

  private getNodeTimeMs(): number {
    return this.node.getRegister('time_now') || Date.now();
  }

  setTime(nowMs: number) {
    this.node.setRegister('time_now', nowMs);
  }
}
