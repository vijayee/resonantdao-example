import {
  HandlerState,
  HandlerOperation,
} from 'crabs-wasm';
import {
  makeAddMemberHandler,
  makeCreateProposalHandler,
  makeVoteHandler,
  makeExecuteHandler,
  makeStartElectionHandler,
  makeCastBallotHandler,
  makeCastRunoffVoteHandler,
  makeFinalizeElectionHandler,
  makeRemoveMemberHandler,
} from '../../shared/src/handlers';
import { ELECTION_NAMES, STATE_NAMES, VOTE_THRESHOLD, runoffId } from '../../shared/src/policies';

class MockNode {
  orSets = new Set<string>();
  registers = new Map<string, number>();
  pnCounters = new Map<string, number>();
  oneShotSets = new Set<string>();

  addORSet(name: string) {
    if (this.orSets.has(name)) throw new Error('duplicate_operation');
    this.orSets.add(name);
  }
  addRegister(name: string, initial = 0) {
    if (this.registers.has(name)) throw new Error('duplicate_operation');
    this.registers.set(name, initial);
  }
  addPNCounter(name: string) {
    if (this.pnCounters.has(name)) throw new Error('duplicate_operation');
    this.pnCounters.set(name, 0);
  }
  addOneShotSet(name: string) {
    if (this.oneShotSets.has(name)) throw new Error('duplicate_operation');
    this.oneShotSets.add(name);
  }
}

class MockState implements HandlerState {
  private sets = new Map<string, Set<string>>();
  private setTags = new Map<string, Map<string, string>>();
  private registers = new Map<string, number>();
  private pnCounters = new Map<string, number>();
  private node: MockNode;

  constructor(node: MockNode) {
    this.node = node;
  }

  private ensureSet(name: string) {
    if (!this.sets.has(name)) {
      this.sets.set(name, new Set());
      this.setTags.set(name, new Map());
    }
  }

  incrementCounter(): void { throw new Error('not implemented'); }
  incrementPNCounter(name: string, delta = 1): void {
    this.pnCounters.set(name, (this.pnCounters.get(name) || 0) + delta);
  }
  decrementPNCounter(name: string, delta = 1): void {
    this.pnCounters.set(name, (this.pnCounters.get(name) || 0) - delta);
  }
  setRegister(name: string, value: number, _nodeId?: string): void {
    this.registers.set(name, value);
  }
  setAdd(name: string, element: string, tag = element): void {
    this.ensureSet(name);
    this.sets.get(name)!.add(element);
    this.setTags.get(name)!.set(element, tag);
  }
  setRemove(name: string, element: string): void {
    this.ensureSet(name);
    this.sets.get(name)!.delete(element);
    this.setTags.get(name)!.delete(element);
  }
  flagSet(): void { throw new Error('not implemented'); }
  getCounter(): number { return 0; }
  getPNCounter(name: string): number {
    return this.pnCounters.get(name) || 0;
  }
  getRegister(name: string): number {
    return this.registers.get(name) ?? this.node.registers.get(name) ?? 0;
  }
  setContains(name: string, element: string): boolean {
    return this.sets.has(name) && this.sets.get(name)!.has(element);
  }
}

function makeOp(type: string, signerId: string, payload: object): HandlerOperation {
  return {
    type,
    signerId,
    nodeId: 'browser',
    payload: JSON.stringify(payload),
  };
}

function setupProposal(
  node: MockNode,
  state: MockState,
  proposalId: string,
  proposalType: 'direct' | 'quadratic',
  expiresAt: number,
  options: string[] = ['Yes', 'No'],
  nowMs = 0
) {
  const handler = makeCreateProposalHandler(node, { getTimeMs: () => nowMs });
  const res = handler(state, makeOp('create_proposal', 'alice', {
    proposalId,
    title: 'Test',
    description: 'Desc',
    proposalType,
    options,
    expiresAt,
  }));
  expect(res).toBe(0);
}

function initUser(state: MockState, username: string, balance: number = 20) {
  // $RES balance is credited only by verified contributions; unit tests
  // simulate that by writing the balance register directly. Only pins
  // remove_member zeroing — quadratic votes no longer read res:.
  state.setRegister(`res:${username}`, balance);
}

// Settled contribution tally for one dimension of a submitter — the input
// that salient-derived vote balances are computed from.
function seedTally(state: MockState, username: string, dimIndex: number, value: number) {
  state.setRegister(`dim:${username}:c${dimIndex}`, value);
}

describe('salient-derived vote balance', () => {
  it('quadratic vote draws from base + salient tallies (not res: register)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupProposal(node, state, 'p-sal', 'quadratic', 100000);
    // C_1 salient; alice settled building contributions → tally 10 → balance 3 + 10 = 13
    state.setRegister('proposals:p-sal:salient', (1 << 1));
    seedTally(state, 'alice', 1, 10);
    // alice has NO res: register at all — proves the vote reads tallies, not tokens
    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    // 3 quadratic votes at cumulative 1+4+9=14 > 13 → exactly 2 votes
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-sal', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-sal', choice: 0 }))).toBe(0);
    expect(state.getPNCounter('votes:p-sal:opt0_count')).toBe(2);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-sal', choice: 0 }))).toBe(-1);
  });

  it('base-only proposals (empty salient mask) give every member the base balance', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupProposal(node, state, 'p-base', 'quadratic', 100000);
    state.setRegister('proposals:p-base:salient', 0);
    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    // base 3: cumulative 1+4 = 5 > 3 → exactly 1 vote
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-base', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p-base', choice: 0 }))).toBe(-1);
    // base is identical for a member with NO contributions
    state.setAdd(STATE_NAMES.members, 'nobody', 'nobody');
    expect(vote(state, makeOp('vote', 'nobody', { proposalId: 'p-base', choice: 0 }))).toBe(0);
  });

  it('create_proposal writes the salient mask from payload; invalid subsets rejected', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const nowMs = 0;
    const make = makeCreateProposalHandler(node, { getTimeMs: () => nowMs });
    expect(make(state, makeOp('create_proposal', 'alice', {
      proposalId: 'p1', title: 'T', description: 'D', proposalType: 'quadratic', options: ['Yes', 'No'], expiresAt: 1000, salientDims: [1, 18],
    }))).toBe(0);
    expect(state.getRegister('proposals:p1:salient')).toBe((1 << 1) | (1 << 18));
    expect(make(state, makeOp('create_proposal', 'alice', {
      proposalId: 'p2', title: 'T', description: 'D', proposalType: 'direct', options: ['Yes', 'No'], expiresAt: 1000,
    }))).toBe(0);
    expect(state.getRegister('proposals:p2:salient')).toBe(0); // absent → base-only
    expect(make(state, makeOp('create_proposal', 'alice', {
      proposalId: 'p3', title: 'T', description: 'D', proposalType: 'direct', options: ['Yes', 'No'], expiresAt: 1000, salientDims: [22],
    }))).toBe(-1);
  });
});

describe('Governance handlers', () => {
  it('rejects duplicate direct votes from the same user', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'direct', 1000);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(2);

    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 1 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(2);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(0);
  });

  it('records multiple-choice direct votes per option and rejects duplicates', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'direct', 1000, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 2 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(state.getPNCounter('votes:p1:opt2_count')).toBe(1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(1);

    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 1 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(0);
  });

  it('rejects votes for unknown option indexes', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'direct', 1000, ['Alpha', 'Beta']);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 2 }))).toBe(-1);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: -1 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(0);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(0);
  });

  it('charges n^2 across different quadratic options and caps at the salient-derived balance', () => {
    const node = new MockNode();
    const state = new MockState(node);

    setupProposal(node, state, 'p1', 'quadratic', 1000, ['Alpha', 'Beta', 'Gamma']);
    // C_1 salient; tally 17 → balance base 3 + 17 = 20.
    state.setRegister('proposals:p1:salient', (1 << 1));
    seedTally(state, 'alice', 1, 17);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    // Cumulative costs after n votes: 1, 5, 14. Balance is 20, so three votes succeed.
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 1 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 2 }))).toBe(0);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(1);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(1);
    expect(state.getPNCounter('votes:p1:opt2_count')).toBe(1);

    // Fourth vote would bring cumulative cost to 30, exceeding balance 20.
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(1);
  });

  it('rejects a quadratic vote when the balance is below the cumulative cost', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupProposal(node, state, 'p0', 'quadratic', 100000, ['Yes', 'No'], 0);
    // Base-only balance 3 (the `|| 3` floor makes a zero balance unreachable,
    // so the minimal allow-then-reject pin is: vote 1 costs 1 <= 3, vote 2
    // costs cumulative 5 > 3). No mask register, no tallies seeded.
    state.setRegister('proposals:p0:salient', 0);
    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p0', choice: 0 }))).toBe(0); // vote 1 costs 1 <= 3
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p0', choice: 0 }))).toBe(-1); // vote 2 costs 5 > 3
    expect(state.getPNCounter('votes:p0:opt0_count')).toBe(1); // rejected vote records nothing
  });

  it('accepts a quadratic vote exactly at the boundary, rejects beyond', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupProposal(node, state, 'pb', 'quadratic', 100000, ['Yes', 'No'], 0);
    // C_1 salient; tally 11 → balance base 3 + 11 = 14, cumulative 1+4+9 = 14 at exactly 3 votes
    state.setRegister('proposals:pb:salient', (1 << 1));
    seedTally(state, 'alice', 1, 11);
    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'pb', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'pb', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'pb', choice: 0 }))).toBe(0); // cumulative 14 <= 14
    expect(state.getPNCounter('votes:pb:opt0_count')).toBe(3);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'pb', choice: 0 }))).toBe(-1); // 4th vote fails
  });

  it('rejects proposals with invalid option lists', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeCreateProposalHandler(node, { getTimeMs: () => 0 });

    const base = { title: 'T', description: 'D', proposalType: 'direct' as const };
    // Too few options
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad1', options: ['Only'], expiresAt: 1000 }))).toBe(-1);
    // Duplicate labels
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad2', options: ['A', 'A'], expiresAt: 1000 }))).toBe(-1);
    // Too many options
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad3', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], expiresAt: 1000 }))).toBe(-1);
    // Empty label
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad4', options: ['A', ''], expiresAt: 1000 }))).toBe(-1);
    // Nothing was created
    expect(state.getRegister('proposals:bad1:option_count')).toBe(0);
  });

  it('passes a binary proposal on strict majority, equivalently to yes > no', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);
    initUser(state, 'bob', 0);

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 0 }));

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'alice', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(1);
    expect(state.getRegister('proposals:p1:winner')).toBe(1); // option index 0 + 1
    expect(state.getRegister('proposals:p1:executed')).toBe(1);
  });

  it('fails a tied binary proposal after expiry', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);
    initUser(state, 'bob', 0);

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 1 }));

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'alice', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(0);
    expect(state.getRegister('proposals:p1:winner')).toBe(0);
    expect(state.getRegister('proposals:p1:executed')).toBe(1);
  });

  it('records a majority winner on a multiple-choice proposal', () => {
    const node = new MockNode();
    const state = new MockState(node);
    for (const voter of ['v1', 'v2', 'v3']) {
      initUser(state, voter, 0);
    }

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    vote(state, makeOp('vote', 'v1', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'v2', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'v3', { proposalId: 'p1', choice: 1 }));

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'v1', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(1);
    expect(state.getRegister('proposals:p1:winner')).toBe(1); // 'Alpha' = index 0 + 1
    expect(state.getRegister('proposals:p1:executed')).toBe(1);
  });

  it('fails a plurality without majority (5/3/3 split)', () => {
    const node = new MockNode();
    const state = new MockState(node);

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    const voters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    voters.forEach((v, i) => {
      const choice = i < 5 ? 0 : i < 8 ? 1 : 2;
      expect(vote(state, makeOp('vote', v, { proposalId: 'p1', choice }))).toBe(0);
    });

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'a', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(0);
    expect(state.getRegister('proposals:p1:winner')).toBe(0);
  });

});

describe('Election handlers', () => {
  let node: MockNode;
  let state: MockState;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // seed members set via add_member semantics
    const addMember = makeAddMemberHandler();
    addMember(state, makeOp('add_member', 'admin', { username: 'alice', publicKeyHex: 'pk-a' }));
    addMember(state, makeOp('add_member', 'admin', { username: 'bob', publicKeyHex: 'pk-b' }));
    addMember(state, makeOp('add_member', 'admin', { username: 'carol', publicKeyHex: 'pk-c' }));
  });

  function startElection(id: string, candidates = ['alice', 'bob', 'carol'], nowMs = 0) {
    const handler = makeStartElectionHandler(node, { getTimeMs: () => nowMs });
    return handler(state, makeOp('start_election', 'alice', {
      electionId: id, candidates, expiresAt: 1000,
    }));
  }

  it('creates election resources for a valid candidate list', () => {
    expect(startElection('e1')).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.expires('e1'))).toBe(1000);
    expect(state.getRegister(ELECTION_NAMES.isRunoff('e1'))).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.seats('e1'))).toBe(5);
    expect(state.setContains(ELECTION_NAMES.candidates('e1'), 'alice')).toBe(true);
  });

  it('rejects candidates who are not members and duplicate candidates', () => {
    expect(startElection('e1', ['alice', 'dave'])).toBe(-1);
    expect(startElection('e2', ['alice', 'alice'])).toBe(-1);
    expect(state.getRegister(ELECTION_NAMES.expires('e1'))).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.expires('e2'))).toBe(0);
  });

  it('rejects a duplicate election id', () => {
    expect(startElection('e1')).toBe(0);
    expect(startElection('e1')).toBe(-1);
  });

  it('accepts one ballot per voter with up to 5 picks', () => {
    startElection('e1');
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob', 'carol'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'bob', { electionId: 'e1', picks: ['alice'] }))).toBe(0);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'bob'))).toBe(1);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'carol'))).toBe(1);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'alice'))).toBe(1);

    // Second ballot from the same voter is rejected.
    expect(ballot(state, makeOp('cast_ballot', 'bob', { electionId: 'e1', picks: ['alice'] }))).toBe(-1);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'alice'))).toBe(1);
  });

  it('does not consume the voter ballot slot when a pick is invalid', () => {
    startElection('e1');
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    // Mixed ballot: one valid pick, one unknown candidate.
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob', 'zebra'] }))).toBe(-1);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'bob'))).toBe(0);
    // The voter can still cast a fully valid ballot afterwards.
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob'] }))).toBe(0);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'bob'))).toBe(1);
  });

  it('rejects ballots with invalid picks, counts, or expired elections', () => {
    startElection('e1');
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    // Unknown candidate (not in this election)
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['zebra'] }))).toBe(-1);
    // Duplicate pick
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob', 'bob'] }))).toBe(-1);
    // Too many picks
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['a2', 'a3', 'a4', 'a5', 'a6', 'bob'] }))).toBe(-1);
    // Empty picks
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: [] }))).toBe(-1);
    // Unknown election
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'nope', picks: ['bob'] }))).toBe(-1);
    // After expiry
    const expired = makeCastBallotHandler({ getTimeMs: () => 1001 });
    expect(expired(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob'] }))).toBe(-1);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes('e1', 'bob'))).toBe(0);
  });

  function ballotFor(voter: string, picks: string[], time = 0) {
    const ballot = makeCastBallotHandler({ getTimeMs: () => time });
    expect(ballot(state, makeOp('cast_ballot', voter, { electionId: 'e1', picks }))).toBe(0);
  }

  it('finalizes with clear winners after expiry', () => {
    startElection('e1');
    ballotFor('alice', ['alice', 'bob', 'carol']);
    ballotFor('bob', ['alice']);
    ballotFor('carol', ['alice', 'bob']);

    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 1001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e1', candidates: ['alice', 'bob', 'carol'] }))).toBe(0);

    expect(state.getRegister(ELECTION_NAMES.finalized('e1'))).toBe(1);
    expect(state.setContains(ELECTION_NAMES.winners('e1'), 'alice')).toBe(true);
    expect(state.setContains(ELECTION_NAMES.winners('e1'), 'bob')).toBe(true);
    expect(state.setContains(ELECTION_NAMES.winners('e1'), 'carol')).toBe(true);
  });

  it('spawns a quadratic runoff when the seat cutoff is tied', () => {
    const addMember = makeAddMemberHandler();
    addMember(state, makeOp('add_member', 'admin', { username: 'dave', publicKeyHex: 'pk-d' }));
    addMember(state, makeOp('add_member', 'admin', { username: 'erin', publicKeyHex: 'pk-e' }));
    addMember(state, makeOp('add_member', 'admin', { username: 'fred', publicKeyHex: 'pk-f' }));

    startElection('e2', ['alice', 'bob', 'carol', 'dave', 'erin', 'fred']);
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    // alice 6, dave 6, erin 5, fred 4 clear the cutoff; bob & carol tie at 1 vote for the last seat
    expect(ballot(state, makeOp('cast_ballot', 'bob', { electionId: 'e2', picks: ['alice', 'bob'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'carol', { electionId: 'e2', picks: ['alice', 'dave', 'carol'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'dave', { electionId: 'e2', picks: ['alice', 'dave', 'erin'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'erin', { electionId: 'e2', picks: ['alice', 'dave', 'fred'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e2', picks: ['alice', 'dave', 'erin', 'fred'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'fred', { electionId: 'e2', picks: ['alice', 'dave', 'erin', 'fred'] }))).toBe(0);

    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 1001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e2', candidates: ['alice', 'bob', 'carol', 'dave', 'erin', 'fred'] }))).toBe(0);

    // four candidates clear the cutoff; bob/carol tied at the cutoff -> runoff, 1 seat at stake
    expect(state.getRegister(ELECTION_NAMES.finalized('e2'))).toBe(2);
    expect(state.setContains(ELECTION_NAMES.winners('e2'), 'alice')).toBe(true);
    expect(state.getRegister(ELECTION_NAMES.isRunoff(runoffId('e2')))).toBe(1);
    expect(state.getRegister(ELECTION_NAMES.seats(runoffId('e2')))).toBe(1);
    expect(state.getRegister(ELECTION_NAMES.expires(runoffId('e2')))).toBe(1001 + 60000);
    expect(state.setContains(ELECTION_NAMES.candidates(runoffId('e2')), 'bob')).toBe(true);
    expect(state.setContains(ELECTION_NAMES.candidates(runoffId('e2')), 'carol')).toBe(true);
    expect(state.setContains(ELECTION_NAMES.candidates(runoffId('e2')), 'alice')).toBe(false);

    // Double finalize is idempotent while runoff pending.
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e2', candidates: ['alice', 'bob', 'carol', 'dave', 'erin', 'fred'] }))).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.finalized('e2'))).toBe(2);
  });

  it('finalizes with empty seats when nobody receives votes', () => {
    startElection('e3');
    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 1001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e3', candidates: ['alice', 'bob', 'carol'] }))).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.finalized('e3'))).toBe(1);
    expect(state.setContains(ELECTION_NAMES.winners('e3'), 'alice')).toBe(false);
  });

  it('rejects finalize before expiry or for unknown elections', () => {
    startElection('e4');
    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 0 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e4', candidates: ['alice', 'bob', 'carol'] }))).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.finalized('e4'))).toBe(0);
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'zz', candidates: ['alice'] }))).toBe(-1);
  });

  function setupRunoff(parentId: string, tied: string[], seatsAtStake: number) {
    // Spawn a runoff the same way the finalize handler does.
    const rid = runoffId(parentId);
    try { node.addORSet(ELECTION_NAMES.ballots(rid)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(ELECTION_NAMES.candidates(rid)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(ELECTION_NAMES.mirrorSet(rid)); } catch (err) { /* ignore duplicate */ }
    for (const c of tied) {
      try { node.addPNCounter(ELECTION_NAMES.candVotes(rid, c)); } catch (err) { /* ignore duplicate */ }
      state.setAdd(ELECTION_NAMES.candidates(rid), c, 'system');
    }
    try { node.addRegister(ELECTION_NAMES.expires(rid), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.finalized(rid), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.isRunoff(rid), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.seats(rid), 0); } catch (err) { /* ignore duplicate */ }
    state.setRegister(ELECTION_NAMES.expires(rid), 100000, 'system');
    state.setRegister(ELECTION_NAMES.isRunoff(rid), 1, 'system');
    state.setRegister(ELECTION_NAMES.seats(rid), seatsAtStake, 'system');
    return rid;
  }

  it('charges quadratic runoff votes at the base balance and resolves the seat', () => {
    const rid = setupRunoff('e2', ['bob', 'carol'], 1);

    const vote = makeCastRunoffVoteHandler({ getTimeMs: () => 0 });
    // Runoffs are base-only: balance 3. alice: cumulative 1 <= 3 -> one vote for bob
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(0);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes(rid, 'bob'))).toBe(1);
    // alice's 2nd vote costs cumulative 5 > 3 -> rejected
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(-1);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes(rid, 'bob'))).toBe(1);

    // bob: 1 vote for carol
    expect(vote(state, makeOp('cast_runoff_vote', 'bob', { electionId: rid, candidate: 'carol' }))).toBe(0);
    expect(state.getPNCounter(ELECTION_NAMES.candVotes(rid, 'carol'))).toBe(1);

    // Unknown candidate rejected
    expect(vote(state, makeOp('cast_runoff_vote', 'carol', { electionId: rid, candidate: 'alice' }))).toBe(-1);

    // Runoff finalize: 1-1 tie for the single seat -> alphabetical deadlock guard, bob wins
    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 100001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: rid, candidates: ['bob', 'carol'] }))).toBe(0);
    expect(state.getRegister(ELECTION_NAMES.finalized(rid))).toBe(1);
    expect(state.setContains(ELECTION_NAMES.winners('e2'), 'bob')).toBe(true);
    expect(state.getRegister(ELECTION_NAMES.finalized('e2'))).toBe(1);
  });

  it('breaks a tied runoff alphabetically (deadlock guard)', () => {
    const rid = setupRunoff('e2', ['bob', 'carol'], 1);
    const vote = makeCastRunoffVoteHandler({ getTimeMs: () => 0 });
    // base-only: one vote per voter. alice -> bob, bob -> carol => tie 1-1
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(0);
    expect(vote(state, makeOp('cast_runoff_vote', 'bob', { electionId: rid, candidate: 'carol' }))).toBe(0);
    // tie 1-1 for one seat -> alphabetical: 'bob' < 'carol'
    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 100001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: rid, candidates: ['bob', 'carol'] }))).toBe(0);
    expect(state.setContains(ELECTION_NAMES.winners('e2'), 'bob')).toBe(true);
    expect(state.setContains(ELECTION_NAMES.winners('e2'), 'carol')).toBe(false);
  });

  it('rejects runoff votes on non-runoff or finalized elections', () => {
    startElection('e5');
    const vote = makeCastRunoffVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: 'e5', candidate: 'bob' }))).toBe(-1);
    const rid = setupRunoff('e2', ['bob', 'carol'], 1);
    const fin = makeFinalizeElectionHandler(node, { getTimeMs: () => 100001 });
    fin(state, makeOp('finalize_election', 'alice', { electionId: rid, candidates: ['bob', 'carol'] }));
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(-1);
  });

  it('removes members and zeroes their RES balance', () => {
    initUser(state, 'dave', 7);
    const addMember = makeAddMemberHandler();
    addMember(state, makeOp('add_member', 'admin', { username: 'dave', publicKeyHex: 'pk-d' }));

    const removeMember = makeRemoveMemberHandler();
    expect(removeMember(state, makeOp('remove_member', 'alice', { username: 'dave' }))).toBe(0);
    expect(state.setContains('members', 'dave')).toBe(false);
    expect(state.getRegister('res:dave')).toBe(0);

    expect(removeMember(state, makeOp('remove_member', 'alice', { username: 'dave' }))).toBe(-1);
    expect(removeMember(state, makeOp('remove_member', 'alice', { username: 'ghost' }))).toBe(-1);
  });
});
