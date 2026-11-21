// C_9 Hermit (slice #6h) — the discovery claim: the milestone machinery VERBATIM
// (the C_7 two-verify-step shape) with ONE new piece: the ADOPTION TIE — an
// OPTIONAL payload field `proposalId` naming a proposal the machine says was
// EXECUTED. The tie validates at SUBMIT (stamped into the adoptedTie OR-set),
// is RE-CARRIED + pinned at verify (not trusted — the stamps referee), and the
// filer earns the flat +5 $RES adoption bonus at the FINAL verify when the tie
// is present.
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import {
  DIMENSIONS,
  SCHEMA_VERSION,
  SCHEMAS,
  STATUS_ACCEPTED,
  dimensionDeltaFor,
  fromRegisterUnits,
} from '../../shared/src/contribution';
import { RES_CONFIG } from '../../shared/src/policies';
import {
  makeCreateProposalHandler,
  makeExecuteHandler,
  makeSettleContributionHandler,
  makeSubmitContributionHandler,
  makeVerifyContributionHandler,
  makeVoteHandler,
} from '../../shared/src/handlers';
import {
  CHECK_NAMES,
  CONTRIB_NAMES,
  RECIP_NAMES,
  RES_NAMES,
  STATE_NAMES,
  TOKEN_NAMES,
} from '../../shared/src/policies';
import {
  ContributionPayload,
  ExecutePayload,
  ProposalPayload,
  SettleContributionPayload,
  VerifyContributionPayload,
  VotePayload,
} from '../../shared/src/types';

// The mock surface mirrors c7-milestone.test.ts (real handlers, real register
// ids, so every arc's writes are handler-stamped).
class MockNode {
  orSets = new Set<string>();
  registers = new Map<string, number>();
  pnCounters = new Map<string, number>();

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
    if (this.orSets.has(name)) throw new Error('duplicate_operation');
    this.orSets.add(name);
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
  setRegisterBytes(): void { throw new Error('not implemented'); }
  getResource(): number { throw new Error('not implemented'); }
  adjustResource(): void { throw new Error('not implemented'); }
  getRegisterBytes(): Uint8Array { throw new Error('not implemented'); }
  getSetSize(name: string): number {
    return this.sets.has(name) ? this.sets.get(name)!.size : 0;
  }
  getSetElements(name: string): string[] {
    return Array.from(this.sets.get(name) ?? []).sort();
  }
  getSetTags(name: string, element: string): string[] {
    return this.setContains(name, element) ? [this.setTags.get(name)?.get(element) ?? ''] : [];
  }
  setAdd(name: string, element: string, tag = element): void {
    this.ensureSet(name);
    // Real CRABS dedupes OR-Set adds by TAG: a reused tag silently drops the
    // earlier element (the documented rule above the explanation records). The
    // mock mirrors it, so a tag-collision regression fails HERE, not on a real
    // replica.
    for (const [priorElement, priorTag] of this.setTags.get(name) ?? []) {
      if (priorTag === tag && priorElement !== element) {
        this.sets.get(name)!.delete(priorElement);
        this.setTags.get(name)!.delete(priorElement);
      }
    }
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

const GOOD_REF = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };

function makeOp(type: string, signerId: string, payload: object): HandlerOperation {
  return {
    type,
    signerId,
    nodeId: 'browser',
    payload: JSON.stringify(payload),
    resources: [],
  };
}

function proposalPayload(proposalId: string): ProposalPayload {
  return {
    proposalId,
    title: 'Adopt the finding',
    description: 'the decision the finding steered',
    proposalType: 'direct',
    options: ['Yes', 'No'],
    expiresAt: 1000 + 60_000,
  };
}

function submitOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return {
    contributionId: 'c-discover',
    dims: { '9': 1 },
    summary: 'discovered how the thing steers',
    evidenceRef: GOOD_REF,
    schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as ContributionPayload;
}

function milestoneClaimOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return submitOp({ verifiers: ['bob'], ...payload } as Partial<ContributionPayload>);
}

function verifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
  return makeOp('verify_contribution', signer, {
    contributionId: 'c-discover', submitter: 'alice', dims: { '9': 1 }, stepId: 'verify',
    pass: true, reason: 'checkpoint holds', schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as VerifyContributionPayload);
}

function settleOp(signer: string, payload: Partial<SettleContributionPayload>): HandlerOperation {
  return makeOp('settle_contribution', signer, {
    contributionId: 'c-discover', submitter: 'alice', reason: 'both milestones proven',
    ...payload,
  } as SettleContributionPayload);
}

// The discovery arc's shared fixture: two verify STAGES (the C_7 machinery
// verbatim) and the proposal ops so every adoption gate reads REAL machine
// state — a created proposal only becomes the tie's truth once the execute
// handler has stamped it.
function arc(): {
  node: MockNode; state: MockState;
  createProposal: (proposalId: string) => number;
  vote: (voter: string, proposalId: string) => number;
  execute: (executor: string, proposalId: string) => number;
  submit: (state: HandlerState, op: HandlerOperation) => number;
  verify: (state: HandlerState, op: HandlerOperation) => number;
  settle: (state: HandlerState, op: HandlerOperation) => number;
  tally: (username: string, dimIndex: number) => number;
  res: (username: string) => number;
} {
  const node = new MockNode();
  const state = new MockState(node);
  for (const u of ['alice', 'bob', 'carol']) {
    state.setAdd(STATE_NAMES.members, u, u);
  }
  const create = makeCreateProposalHandler(node, { getTimeMs: () => 1000 });
  const vote = makeVoteHandler({ getTimeMs: () => 1000 });
  const execute = makeExecuteHandler({ getTimeMs: () => 1000 });
  const submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
  const verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
  const settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
  return {
    node, state, createProposal: (id) => create(state, makeOp('create_proposal', 'alice', proposalPayload(id))),
    vote: (voter, id) => vote(state, makeOp('vote', voter, { proposalId: id, choice: 0 } as VotePayload)),
    execute: (executor, id) => execute(state, makeOp('execute', executor, { proposalId: id } as ExecutePayload)),
    submit, verify, settle,
    tally: (username, dimIndex) => fromRegisterUnits(state.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex))),
    res: (username) => fromRegisterUnits(state.getRegister(RES_NAMES.balance(username))),
  };
}

// A proposal carried to the machine's EXECUTED state (create → 2-vote quorum →
// execute): the tie's truth. `openProposal` stops before the quorum.
function executedProposal(h: ReturnType<typeof arc>, proposalId: string): void {
  expect(h.createProposal(proposalId)).toBe(0);
  expect(h.vote('alice', proposalId)).toBe(0);
  expect(h.vote('bob', proposalId)).toBe(0);
  expect(h.execute('carol', proposalId)).toBe(0);
  expect(h.state.getRegister(TOKEN_NAMES.proposalExecuted(proposalId))).toBe(1);
}

describe('the C_9 schema is wired (the discovery claim, slice #6h)', () => {
  // Contracts:
  // W-9-A: SCHEMAS.get(9) holds the C_7-shaped two-verify walk — submit →
  //        verify (M1) → verify-2 (M2) → settle; BOTH gates are plain single-
  //        count checks and the M2 stepId is DISTINCT (the verify handler
  //        matches the payload's stepId against the CURRENT step's).
  // W-9-B: the dim is implemented AND pickable; dimensionDeltaFor(9, 1) === 1;
  //        RES_CONFIG.adoptionBonus is the 5 $RES the tie pays.
  it('W-9-A. SCHEMAS.get(9) holds submit/verify/verify-2/settle; both gates plain single checks; verify-2 is a DISTINCT stepId', () => {
    const schema = SCHEMAS.get(9);
    expect(schema).toBeDefined();
    expect(schema!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(schema!.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'verify-2', 'settle']);
    const [m1, m2] = schema!.steps.filter((s) => s.op === 'verify_contribution');
    expect(m1.requirement).toEqual({ mode: 'single', count: 1 });
    expect(m1.actors).toEqual(['verifier']);
    expect(m2.stepId).toBe('verify-2');
    expect(m2.requirement).toEqual({ mode: 'single', count: 1 });
    expect(m2.actors).toEqual(['verifier']);
    expect(schema!.steps[3].op).toBe('settle_contribution');
  });

  it('W-9-B. the dim is implemented AND pickable; the match rule is the generic 1; the adoption bonus is 5 $RES', () => {
    expect(DIMENSIONS[9].implemented).toBe(true);
    expect(DIMENSIONS[9].pickable).toBe(true);
    expect(dimensionDeltaFor(9, 1)).toBe(1);
    expect(RES_CONFIG.adoptionBonus).toBe(5);
  });
});

describe('C_9 submit: the adoption tie is OPTIONAL and machine-pinned', () => {
  // Contracts:
  // S-9-A: a NO-TIE discovery claim (the optional field absent) submits → 0;
  //        the adoptedTie set is declared (every claim rule's tieSets are) and
  //        stays EMPTY — no stamp on a no-tie claim.
  // S-9-B: an EXECUTED-tie claim submits → 0; the tie is stamped into the
  //        adoptedTie OR-set (the pin the verify gate later reads).
  // S-9-C: a tie to a proposal that exists but is NOT yet executed → -1 — the
  //        machine's adoption truth is the executed register (D-C). A tie to
  //        a proposal that does not exist at all → -1 likewise.
  it('S-9-A. a no-tie claim submits; the adoptedTie set is declared and stays empty', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.state.setContains(STATE_NAMES.contributions, 'c-discover')).toBe(true);
    expect(h.state.getSetSize(CONTRIB_NAMES.adoptedTie('c-discover'))).toBe(0);
  });

  it('S-9-B. an executed-tie claim submits and stamps the tie into the adoptedTie set', () => {
    const h = arc();
    executedProposal(h, 'p-exec');
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-exec' })))).toBe(0);
    expect(h.state.setContains(CONTRIB_NAMES.adoptedTie('c-discover'), 'p-exec')).toBe(true);
  });

  it('S-9-C. an unexecuted or missing tie is rejected (-1) — nothing moved', () => {
    const h = arc();
    // Created but never executed: the executed register still holds 0.
    expect(h.createProposal('p-open')).toBe(0);
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-open' })))).toBe(-1);
    // Not created at all.
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-ghost' })))).toBe(-1);
    // All-or-nothing: neither submission exists.
    expect(h.state.setContains(STATE_NAMES.contributions, 'c-discover')).toBe(false);
    expect(h.state.getSetElements(STATE_NAMES.contributions)).toEqual([]);
  });
});

describe('C_9 verify: two gates, the tally once, the bonus only with the tie', () => {
  // Contracts (the spec's D-A/D-B):
  // D-A: the NO-TIE arc — M1 advances without credit; M2 is the final gate:
  //      the filer's C_9 tally gains match × alpha FOR ONCE and NO bonus pays
  //      (the adoption bonus needs the tie).
  // D-B: the EXECUTED-tie arc — same walk; the tally fires once AND the
  //      filer's balance gains exactly the +5 $RES bonus at the FINAL verify
  //      (never at M1 — the bonus rides the claim's final completion too).
  it('D-A. the no-tie arc: the tally once at M2, NO bonus', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-discover'))).toBe(2);
    expect(h.tally('alice', 9)).toBe(0);
    expect(h.res('alice')).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.tally('alice', 9)).toBe(1);
    expect(h.res('alice')).toBe(0); // no tie → no adoption bonus
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-discover'))).toBe(3);
  });

  it('D-B. the executed-tie arc: the tally once at M2 AND the +5 $RES bonus at the final gate', () => {
    const h = arc();
    executedProposal(h, 'p-exec');
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-exec' })))).toBe(0);
    // The client flow RE-CARRIES the tie on every verify op (the store's
    // spread) — the handler's bonus hook reads the re-carry.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify', proposalId: 'p-exec' }))).toBe(0);
    // Not final yet: no tally, no bonus (M1 advances only).
    expect(h.tally('alice', 9)).toBe(0);
    expect(h.res('alice')).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2', proposalId: 'p-exec' }))).toBe(0);
    expect(h.tally('alice', 9)).toBe(1);
    expect(h.res('alice')).toBe(5);
    expect(h.settle(h.state, settleOp('alice', { dims: { '9': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-discover'))).toBe(STATUS_ACCEPTED);
    // The explanation records: BOTH verify checks keep their own record (the
    // tag rule — step id + check ordinal — survives the real CRABS' by-tag
    // dedupe; a bare signer tag would have eaten M1's record) and the final
    // one shows the bonus on its payments.
    const records = h.state.getSetElements(CONTRIB_NAMES.explanations('c-discover')).map((r) => JSON.parse(r));
    const verifyRecords = records.filter((r) => r.stepId === 'verify' || r.stepId === 'verify-2');
    expect(verifyRecords).toHaveLength(2);
    const finalRecord = records.find((r) => r.stepId === 'verify-2');
    expect(finalRecord.payments).toEqual({ alice: 5 });
  });
});

describe('C_9 verify gate: the re-carry is pinned against the submit stamps', () => {
  // Contract (the spec's D-D): the verify payload's proposalId is NOT trusted
  // — it must satisfy the adoptedTie stamps. A forged re-carry dies
  // all-or-nothing: no per-check credit, no step move, no tally, no bonus.
  it('D-D. a forged re-carry (a different proposal, or any tie on a no-tie claim) is rejected with nothing moved', () => {
    const h = arc();
    executedProposal(h, 'p-exec');
    executedProposal(h, 'p-other');
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-exec' })))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    // M2 with a DIFFERENT (even executed) proposal re-carried: forged.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2', proposalId: 'p-other' }))).toBe(-1);
    expect(h.res('bob')).toBe(2); // M1's check only — the forged M2 paid nothing
    expect(h.tally('alice', 9)).toBe(0);
    expect(h.res('alice')).toBe(0);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-discover', 'verify-2'))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-discover'))).toBe(2);
    // A no-tie claim whose verify payload carries ANY proposal: forged too.
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', {
      ...milestoneClaimOp({ contributionId: 'c-plain' }), contributionId: 'c-plain',
    }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', {
      contributionId: 'c-plain', stepId: 'verify', proposalId: 'p-other',
    }))).toBe(-1);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-plain', 'verify'))).toBe(0);
  });

  it('D-D2. the honest re-carry walks the gate: the executed-tie M2 passes', () => {
    const h = arc();
    executedProposal(h, 'p-exec');
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-exec' })))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify', proposalId: 'p-exec' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2', proposalId: 'p-exec' }))).toBe(0);
    expect(h.tally('alice', 9)).toBe(1);
    expect(h.res('alice')).toBe(5);
  });
});

describe('C_9 $RES invariant (the spec\'s D-E)', () => {
  // Contract D-E: the adoption bonus is the ONLY money that moves to the
  // filer (the classification dim pays no bounty — paymentFor(9) is 0) and
  // the verifier carries exactly the standing +2 per check. The settle pays
  // nothing. A no-tie claim leaves the filer at zero.
  it('D-E. the executed-tie arc: filer exactly +5, verifier exactly +4 for the two checks', () => {
    const h = arc();
    executedProposal(h, 'p-exec');
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({ proposalId: 'p-exec' })))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify', proposalId: 'p-exec' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2', proposalId: 'p-exec' }))).toBe(0);
    expect(h.settle(h.state, settleOp('alice', { dims: { '9': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.res('alice')).toBe(5);
    expect(h.res('bob')).toBe(4);
    expect(h.state.getRegister(CHECK_NAMES.total('bob'))).toBe(2);
    // The reciprocity record: both gates walked by the SAME named verifier
    // (the milestone carve keys the pair rule per-verify-STEP).
    expect(h.state.setContains(RECIP_NAMES.verifiedBy('alice'), 'bob')).toBe(true);
  });

  it('D-E2. the no-tie arc: the filer ends at zero (no bounty, no bonus)', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.settle(h.state, settleOp('alice', { dims: { '9': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.res('alice')).toBe(0);
    expect(h.res('bob')).toBe(4);
    expect(h.tally('alice', 9)).toBe(1);
  });

  it('D-E3. an execution AFTER a tie-less submit cannot re-validate the claim — the walk stays honest', () => {
    const h = arc();
    // The tie-less claim exists FIRST; a proposal is executed only LATER.
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    executedProposal(h, 'p-later');
    // A verify payload riding the NOW-executed proposal is a forged tie (the
    // claim's stamp set is empty) — the later execution never re-validated it.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify', proposalId: 'p-later' }))).toBe(-1);
    // The honest no-tie walk completes with NO bonus.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.settle(h.state, settleOp('alice', { dims: { '9': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.res('alice')).toBe(0);
    expect(h.tally('alice', 9)).toBe(1);
  });
});
