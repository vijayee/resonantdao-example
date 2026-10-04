import { loadCRABS } from './wasm';
import {
  CONTRIB_NAMES, CUSTODIAN_SEATS, ELECTION_NAMES, POLICIES, RES_NAMES, STATE_NAMES, TOKEN_NAMES, runoffId,
} from '@shared/policies';
import { setOperationSignerKeyVersion } from '@shared/crabs-helpers';
import {
  CastBallotPayload,
  CastRunoffVotePayload,
  ContributionPayload,
  ExecutePayload,
  FinalizeElectionPayload,
  ProposalPayload,
  RemoveMemberPayload,
  StartElectionPayload,
  SettleContributionPayload,
  VerifyContributionPayload,
  SyncRolesPayload,
  VotePayload,
} from '@shared/types';
import {
  makeAddMemberHandler,
  makeCastBallotHandler,
  makeCastRunoffVoteHandler,
  makeCreateProposalHandler,
  makeExecuteHandler,
  makeFinalizeElectionHandler,
  makeRemoveMemberHandler,
  makeSettleContributionHandler,
  makeStartElectionHandler,
  makeSubmitContributionHandler,
  makeVerifyContributionHandler,
  makeVoteHandler,
} from '@shared/handlers';

export interface ContributionMirrorEntry {
  record: ContributionPayload;
  submitter: string;
  submittedAt: number;
  verifiedBy?: string;
  verdict?: boolean;
  verdictReason?: string;
  settledBy?: string;
}

export class BrowserDao {
  private Node: any;
  private KeyPair: any;
  private Operation: any;
  node: any;
  nodeId = 'browser';
  private adminId = 'admin';
  private signingKey: any;
  private keyVersion = 0;

  async init(username: string, signingSeedHex: string, keyVersion: number) {
    const webCrypto = globalThis.crypto;
    if (!webCrypto || !webCrypto.randomUUID) {
      throw new Error('Web Crypto API is not available. Browser DAO requires a secure browser context.');
    }
    const crabs = await loadCRABS();
    this.Node = crabs.Node;
    this.KeyPair = crabs.KeyPair;
    this.Operation = crabs.Operation;

    this.nodeId = webCrypto.randomUUID();
    // Use a unique adminId per browser node. CRABS' Node.sign stamps the
    // operation with this id, so uniqueness avoids HLC collisions on the
    // server mirror when multiple browsers submit operations.
    this.adminId = this.nodeId;
    this.signingKey = await this.KeyPair.fromPrivateHex(signingSeedHex);
    this.keyVersion = keyVersion;
    // The server returns the absolute key version after registration (register=1,
    // plus member and reputation grants = 3). Track that as the baseline so later
    // sync_roles target versions map one-to-one to key version bumps.
    this.roleChangeCount.set(username, keyVersion);
    this.node = await this.Node.create(this.adminId, { ordering: 'hlc' });
    this.node.addORSet(STATE_NAMES.members);
    this.node.addORSet(STATE_NAMES.proposals);
    this.node.addORSet(STATE_NAMES.executedProposals);
    this.node.addORSet(STATE_NAMES.contributions);
    this.node.addRegister('time_now', 0);

    this.node.setPolicy('create_proposal', POLICIES.create_proposal);
    this.node.setPolicy('vote', POLICIES.vote);
    this.node.setPolicy('execute', POLICIES.execute);
    this.node.setPolicy('add_member', POLICIES.add_member);

    this.node.registerHandlerJs('add_member', makeAddMemberHandler());
    this.node.registerHandlerJs('create_proposal', makeCreateProposalHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('vote', makeVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('execute', makeExecuteHandler({ getTimeMs: () => this.getNodeTimeMs() }));

    this.node.setPolicy('start_election', POLICIES.start_election);
    this.node.setPolicy('cast_ballot', POLICIES.cast_ballot);
    this.node.setPolicy('finalize_election', POLICIES.finalize_election);
    this.node.setPolicy('cast_runoff_vote', POLICIES.cast_runoff_vote);
    this.node.setPolicy('remove_member', POLICIES.remove_member);
    this.node.setPolicy('submit_contribution', POLICIES.submit_contribution);
    this.node.setPolicy('verify_contribution', POLICIES.verify_contribution);
    this.node.setPolicy('settle_contribution', POLICIES.settle_contribution);

    this.node.registerHandlerJs('start_election', makeStartElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_ballot', makeCastBallotHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('finalize_election', makeFinalizeElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_runoff_vote', makeCastRunoffVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('remove_member', makeRemoveMemberHandler());
    this.node.registerHandlerJs('submit_contribution', makeSubmitContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('verify_contribution', makeVerifyContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('settle_contribution', makeSettleContributionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('sync_roles', () => 0);

    this.node.registerUser(username, this.signingKey.publicKeyHex());
    // PoC bootstrap: the client locally grants its own membership attributes.
    this.node.grantRole(username, 'role', 'member', this.adminId);
    this.node.grantRole(username, 'reputation', '1', this.adminId);
    this.initResRegisters(username);
    try { this.node.setAdd(STATE_NAMES.members, username, this.signingKey.publicKeyHex()); } catch (err) { /* ignore duplicate */ }
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

  setWalletUser(username: string) {
    this.walletUser = username;
  }

  async startElection(userId: string, payload: StartElectionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('start_election', userId, JSON.stringify(payload));
  }

  async castBallot(userId: string, payload: CastBallotPayload): Promise<Uint8Array> {
    return this.signAndSerialize('cast_ballot', userId, JSON.stringify(payload));
  }

  async finalizeElection(userId: string, payload: FinalizeElectionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('finalize_election', userId, JSON.stringify(payload));
  }

  async castRunoffVote(userId: string, payload: CastRunoffVotePayload): Promise<Uint8Array> {
    return this.signAndSerialize('cast_runoff_vote', userId, JSON.stringify(payload));
  }

  async submitContribution(userId: string, payload: ContributionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('submit_contribution', userId, JSON.stringify(payload));
  }

  async verifyContribution(userId: string, payload: VerifyContributionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('verify_contribution', userId, JSON.stringify(payload));
  }

  async settleContribution(userId: string, payload: SettleContributionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('settle_contribution', userId, JSON.stringify(payload));
  }

  async removeMember(userId: string, payload: RemoveMemberPayload): Promise<Uint8Array> {
    return this.signAndSerialize('remove_member', userId, JSON.stringify(payload));
  }

  registerMember(username: string, publicKeyHex: string, keyVersion = 3) {
    if (this.node.getUser(username)?.status === 'active') return;
    this.node.registerUser(username, publicKeyHex);
    this.node.grantRole(username, 'role', 'member', this.adminId);
    this.node.grantRole(username, 'reputation', '1', this.adminId);
    this.initResRegisters(username);
    try { this.node.setAdd(STATE_NAMES.members, username, publicKeyHex); } catch (err) { /* ignore duplicate */ }
    // Seed the role-change baseline so sync_roles target versions map
    // one-to-one to the key-version bumps applied by the server.
    this.roleChangeCount.set(username, keyVersion);
  }

  private initResRegisters(username: string) {
    try { this.node.addRegister(RES_NAMES.balance(username), 0); } catch (err) { /* ignore duplicate */ }
  }

  private async signAndSerialize(type: string, userId: string, payloadJson: string): Promise<Uint8Array> {
    const op = await this.Operation.create(type);
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
  private contributions = new Map<string, ContributionMirrorEntry>();
  private elections = new Map<string, { electionId: string; candidates: string[]; isRunoff: boolean; seats: number }>();
  custodians: string[] = [];
  private roleChangeCount = new Map<string, number>();
  private walletUser = '';

  serialize(): Uint8Array {
    return this.node.serialize();
  }

  async executeRemote(bytes: Uint8Array): Promise<void> {
    const op = await this.Operation.deserialize(bytes);
    try {
      if (op.type === 'sync_roles') {
        await this.applySyncRolesFromOp(op);
        return;
      }
      this.node.execute(op);
      const proposal = await this.parseCreateProposal(bytes);
      if (proposal) {
        this.proposals.set(proposal.proposalId, proposal);
      }
      await this.mirrorContributionState(op);
      await this.mirrorElectionState(op);
    } finally {
      op.destroy();
    }
  }

  private async parseCreateProposal(bytes: Uint8Array): Promise<ProposalPayload | null> {
    const op = await this.Operation.deserialize(bytes);
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

  private async applySyncRolesFromOp(op: any): Promise<void> {
    let payload: SyncRolesPayload | null = null;
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      payload = JSON.parse(json.replace(/\0$/, '')) as SyncRolesPayload;
    } catch {
      return;
    }
    if (!payload || !Array.isArray(payload.custodians) || typeof payload.roleVersions !== 'object' || payload.roleVersions === null) {
      return;
    }
    this.custodians = payload.custodians.filter((u) => typeof u === 'string');
    for (const [username, version] of Object.entries(payload.roleVersions)) {
      if (typeof version !== 'number' || version < 0) continue;
      const applied = this.roleChangeCount.get(username) ?? 0;
      const isCustodian = this.custodians.includes(username);
      const roleValue = isCustodian ? 'custodian' : 'member';
      const registered = this.node.getUser(username)?.status === 'active';
      if (registered) {
        for (let i = applied; i < version; i++) {
          this.node.grantRole(username, 'role', roleValue, this.adminId);
        }
        this.roleChangeCount.set(username, version);
        if (username === this.walletUser) {
          this.keyVersion = version;
        }
      }
    }
  }

  private async mirrorContributionState(op: any): Promise<void> {
    if (op.type !== 'submit_contribution' && op.type !== 'verify_contribution' && op.type !== 'settle_contribution') {
      return;
    }
    let payload: any = null;
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      payload = JSON.parse(json.replace(/\0$/, ''));
    } catch {
      return;
    }
    if (op.type === 'submit_contribution') {
      if (typeof payload.contributionId === 'string') {
        this.contributions.set(payload.contributionId, {
          record: payload as ContributionPayload,
          submitter: op.signerId,
          submittedAt: this.getNodeTimeMs(),
        });
      }
      return;
    }
    const entry = this.contributions.get(payload.contributionId);
    if (entry) {
      if (op.type === 'verify_contribution') {
        entry.verifiedBy = op.signerId;
        entry.verdict = payload.pass;
        entry.verdictReason = payload.reason;
      } else {
        entry.settledBy = op.signerId;
      }
    }
  }

  getContributions(): ContributionMirrorEntry[] {
    return Array.from(this.contributions.values());
  }

  private async mirrorElectionState(op: any): Promise<void> {
    if (op.type !== 'start_election' && op.type !== 'finalize_election') {
      return;
    }
    let payload: any = null;
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      payload = JSON.parse(json.replace(/\0$/, ''));
    } catch {
      return;
    }
    if (op.type === 'start_election') {
      if (typeof payload.electionId === 'string' && Array.isArray(payload.candidates)) {
        this.elections.set(payload.electionId, {
          electionId: payload.electionId,
          candidates: payload.candidates,
          isRunoff: false,
          seats: CUSTODIAN_SEATS,
        });
      }
      return;
    }
    // finalize_election: if it spawned a runoff, mirror it.
    const id = payload.electionId;
    if (typeof id !== 'string' || !this.elections.has(id)) {
      return;
    }
    if (this.node.getRegister(ELECTION_NAMES.isRunoff(id)) === 1) {
      const rid = runoffId(id);
      const seats = this.node.getRegister(ELECTION_NAMES.seats(rid)) || 0;
      const tied: string[] = [];
      const parent = this.elections.get(id)!;
      for (const candidate of parent.candidates) {
        if (this.node.setContains(ELECTION_NAMES.candidates(rid), candidate)) {
          tied.push(candidate);
        }
      }
      this.elections.set(rid, { electionId: rid, candidates: tied, isRunoff: true, seats });
    }
  }

  getProposals(): ProposalPayload[] {
    return Array.from(this.proposals.values());
  }

  getProposalOptionVotes(id: string): number[] {
    const optionCount = this.node.getRegister(TOKEN_NAMES.proposalOptionCount(id)) || 0;
    const counts: number[] = [];
    for (let i = 0; i < optionCount; i++) {
      counts.push(this.node.getPNCounter(TOKEN_NAMES.optionVoteCount(id, i)) || 0);
    }
    return counts;
  }

  isProposalExecuted(id: string): boolean {
    return this.node.setContains(STATE_NAMES.executedProposals, id);
  }

  getResBalance(username: string): number {
    return this.node.getRegister(RES_NAMES.balance(username)) || 0;
  }

  getDimensionBalance(username: string, dimIndex: number): number {
    return this.node.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex)) || 0;
  }

  getContributionStatus(contributionId: string): 'pending' | 'accepted' | 'rejected' | 'unknown' {
    if (!this.node.setContains(STATE_NAMES.contributions, contributionId)) return 'unknown';
    const status = this.node.getRegister(CONTRIB_NAMES.status(contributionId));
    return status === 1 ? 'accepted' : status === 2 ? 'rejected' : 'pending';
  }

  getContributionStepIndex(contributionId: string): number {
    return this.node.getRegister(CONTRIB_NAMES.step(contributionId)) || 0;
  }

  getContributionStepDone(contributionId: string, stepId: string): number {
    return this.node.getPNCounter(CONTRIB_NAMES.stepDone(contributionId, stepId)) || 0;
  }

  getProposalType(id: string): 'direct' | 'quadratic' | null {
    const type = this.node.getRegister(`proposals:${id}:type`);
    if (type === 1) return 'direct';
    if (type === 2) return 'quadratic';
    return null;
  }

  getProposalExpiry(id: string): number {
    return this.node.getRegister(`proposals:${id}:expires`) || 0;
  }

  getProposalVoteCount(proposalId: string, username: string): number {
    const mirrorSet = TOKEN_NAMES.proposalMirrorSet(proposalId);
    let voteCount = 0;
    const maxVoteCheck = 100;
    for (let i = 1; i <= maxVoteCheck; i++) {
      if (this.node.setContains(mirrorSet, TOKEN_NAMES.proposalMirrorElement(proposalId, username, i))) {
        voteCount = i;
      } else {
        break;
      }
    }
    return voteCount;
  }

  getProposalTokenUsage(proposalId: string, username: string): number {
    const voteCount = this.getProposalVoteCount(proposalId, username);
    // Cumulative quadratic cost: sum of i^2 for i=1..voteCount
    return (voteCount * (voteCount + 1) * (2 * voteCount + 1)) / 6;
  }

  getElections(): Array<{ electionId: string; candidates: string[]; isRunoff: boolean; seats: number }> {
    return Array.from(this.elections.values());
  }

  getElectionVotes(id: string): Record<string, number> {
    const election = this.elections.get(id);
    if (!election) return {};
    const votes: Record<string, number> = {};
    for (const candidate of election.candidates) {
      votes[candidate] = this.node.getPNCounter(ELECTION_NAMES.candVotes(id, candidate)) || 0;
    }
    return votes;
  }

  getElectionExpiry(id: string): number {
    return this.node.getRegister(ELECTION_NAMES.expires(id)) || 0;
  }

  getElectionFinalized(id: string): number {
    return this.node.getRegister(ELECTION_NAMES.finalized(id)) || 0;
  }

  hasBallot(id: string): boolean {
    return this.node.setContains(ELECTION_NAMES.ballots(id), this.walletUser);
  }

  getRunoffUsage(id: string): number {
    let used = 0;
    for (let i = 1; i <= 100; i++) {
      if (this.node.setContains(ELECTION_NAMES.mirrorSet(id), ELECTION_NAMES.mirrorElement(id, this.walletUser, i))) {
        used = i;
      } else {
        break;
      }
    }
    return (used * (used + 1) * (2 * used + 1)) / 6;
  }

  getNodeTimeMs(): number {
    return this.node.getRegister('time_now') || Date.now();
  }

  setTime(nowMs: number) {
    this.node.setRegister('time_now', nowMs);
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
