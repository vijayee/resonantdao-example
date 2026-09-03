import { Node, KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
import {
  CONFIG_NAMES, ELECTION_NAMES, POLICIES, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES,
} from '../../shared/src/policies';
import {
  makeAddMemberHandler,
  makeCastBallotHandler,
  makeCastRunoffVoteHandler,
  makeCreateProposalHandler,
  makeExecuteHandler,
  makeFinalizeElectionHandler,
  makeRemoveMemberHandler,
  makeSetTokenConfigHandler,
  makeStartElectionHandler,
  makeVoteHandler,
} from '../../shared/src/handlers';
import { SyncRolesPayload } from '../../shared/src/types';

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
    this.node.setPolicy('start_election', POLICIES.start_election);
    this.node.setPolicy('cast_ballot', POLICIES.cast_ballot);
    this.node.setPolicy('finalize_election', POLICIES.finalize_election);
    this.node.setPolicy('cast_runoff_vote', POLICIES.cast_runoff_vote);
    this.node.setPolicy('set_token_config', POLICIES.set_token_config);
    this.node.setPolicy('remove_member', POLICIES.remove_member);

    this.node.registerHandlerJs('add_member', makeAddMemberHandler());
    this.node.registerHandlerJs('create_proposal', makeCreateProposalHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('vote', makeVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('execute', makeExecuteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('start_election', makeStartElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_ballot', makeCastBallotHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('finalize_election', makeFinalizeElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_runoff_vote', makeCastRunoffVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('set_token_config', makeSetTokenConfigHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('remove_member', makeRemoveMemberHandler());
    this.node.registerHandlerJs('sync_roles', () => 0); // admin-signed; roles applied out-of-band
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
    // Derive from the actual CRABS user record: registerUser sets 1 and each
    // grantRole (member, reputation, custodian changes) bumps it by 1.
    return this.node.getUser(username)?.keyVersion ?? 0;
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
    this.node.execute(op);
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

  currentCustodians: string[] = [];

  grantCustodian(username: string) {
    this.node.grantRole(username, 'role', 'custodian', ADMIN_ID);
    if (!this.currentCustodians.includes(username)) {
      this.currentCustodians.push(username);
    }
  }

  grantMemberRole(username: string) {
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    this.currentCustodians = this.currentCustodians.filter((u) => u !== username);
  }

  revokeMember(username: string) {
    try {
      this.node.revokeUser(username);
    } catch (err) {
      console.warn('revokeUser failed:', username, err);
    }
  }

  isElectionWinner(electionId: string, username: string): boolean {
    return this.node.setContains(ELECTION_NAMES.winners(electionId), username) || false;
  }

  getUserRoleVersion(username: string): number {
    return this.node.getUser(username)?.keyVersion ?? 0;
  }

  async createSyncRolesOperation(payload: SyncRolesPayload): Promise<Operation> {
    return this.createAdminOperation('sync_roles', payload);
  }

  // Called after every executed operation (live and during hydration). When a
  // finalized election changes the custodian set, applies role grants and
  // returns a sync_roles operation for the caller to persist and broadcast
  // (null when nothing changed).
  async observeOperation(op: Operation): Promise<Operation | null> {
    if (op.type !== 'finalize_election') {
      return null;
    }
    const payload = this.parseFinalizePayload(op);
    if (!payload) {
      return null;
    }
    const winners = payload.candidates.filter((c) => this.isElectionWinner(payload.electionId, c));
    const additions = winners.filter((w) => !this.currentCustodians.includes(w));
    const removed = this.currentCustodians.filter((c) => !winners.includes(c));
    if (winners.length === 0 || (removed.length === 0 && additions.length === 0)) {
      return null;
    }
    const roleVersions: Record<string, number> = {};
    for (const user of [...removed, ...winners]) {
      if (removed.includes(user)) {
        this.grantMemberRole(user);
      } else {
        this.grantCustodian(user);
      }
      roleVersions[user] = this.getUserRoleVersion(user);
    }
    this.currentCustodians = [...winners];
    return this.createSyncRolesOperation({ custodians: this.currentCustodians, roleVersions });
  }

  private parseFinalizePayload(op: Operation): { electionId: string; candidates: string[] } | null {
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const parsed = JSON.parse(json.replace(/\0$/, ''));
      if (!parsed || typeof parsed.electionId !== 'string' || !Array.isArray(parsed.candidates)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
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
