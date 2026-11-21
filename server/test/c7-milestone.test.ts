// C_7 Chariot (slice #6g) — the claim family's milestone shape: a
// TWO-verify-step schema [submit → verify M1 → verify M2 → settle]. The
// milestones shape the credit's TIMING, not its count: both checks are plain
// ops (the same named verifier carries both — the #4c targeted set), and the
// tally credit fires ONCE at the LAST verify step's completion, like every
// claim pays once per contribution.
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import {
  DIMENSIONS,
  SCHEMA_VERSION,
  SCHEMAS,
  STATUS_ACCEPTED,
  dimensionDeltaFor,
  fromRegisterUnits,
} from '../../shared/src/contribution';
import {
  makeAppealVerdictHandler,
  makeSettleContributionHandler,
  makeSubmitContributionHandler,
  makeVerifyContributionHandler,
} from '../../shared/src/handlers';
import { CHECK_NAMES, CONTRIB_NAMES, RECIP_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
import {
  AppealVerdictPayload,
  ContributionPayload,
  SettleContributionPayload,
  VerifyContributionPayload,
} from '../../shared/src/types';

// The mock surface mirrors c15-exposure.test.ts (real handlers, real register
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

function submitOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return {
    contributionId: 'c-drive',
    dims: { '7': 1 },
    summary: 'drove the thing across its milestones',
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
    contributionId: 'c-drive', submitter: 'alice', dims: { '7': 1 }, stepId: 'verify',
    pass: true, reason: 'checkpoint holds', schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as VerifyContributionPayload);
}

function settleOp(signer: string, payload: Partial<SettleContributionPayload>): HandlerOperation {
  return makeOp('settle_contribution', signer, {
    contributionId: 'c-drive', submitter: 'alice', reason: 'both milestones proven',
    ...payload,
  } as SettleContributionPayload);
}

function appealOp(signer: string, payload: Partial<AppealVerdictPayload>): HandlerOperation {
  return makeOp('appeal_verdict', signer, {
    contributionId: 'c-drive', submitter: 'alice', reason: 'the verdict misread the evidence',
    ...payload,
  } as AppealVerdictPayload);
}

// The milestone arc's shared fixture: two verify STAGES mean the same named
// verifier runs TWO ops on ONE record — the pair-once rule's per-milestone
// carve is what makes that legal (M-F pins its single-verify counterpart).
function arc(): {
  node: MockNode; state: MockState;
  submit: (state: HandlerState, op: HandlerOperation) => number;
  verify: (state: HandlerState, op: HandlerOperation) => number;
  settle: (state: HandlerState, op: HandlerOperation) => number;
  appeal: (state: HandlerState, op: HandlerOperation) => number;
  tally: (username: string, dimIndex: number) => number;
  res: (username: string) => number;
} {
  const node = new MockNode();
  const state = new MockState(node);
  for (const u of ['alice', 'bob', 'carol']) {
    state.setAdd(STATE_NAMES.members, u, u);
  }
  const submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
  const verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
  const settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
  const appeal = makeAppealVerdictHandler(node, { getTimeMs: () => 6000 });
  return {
    node, state, submit, verify, settle, appeal,
    tally: (username, dimIndex) => fromRegisterUnits(state.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex))),
    res: (username) => fromRegisterUnits(state.getRegister(RES_NAMES.balance(username))),
  };
}

describe('the C_7 schema is wired (the milestone claim, slice #6g)', () => {
  // Contracts:
  // W-7-A: SCHEMAS.get(7) holds submit → verify (M1) → verify-2 (M2) →
  //         settle; BOTH verify stages are plain single-count checks; the
  //         M2 step's op is 'verify_contribution' (the standing machinery
  //         walks it); the M2 stepId is DISTINCT ('verify-2' — the verify
  //         handler matches the payload's stepId against the CURRENT step's,
  //         so identical ids would collide the two gates into one).
  // W-7-B: the dim is implemented AND pickable (the claim surfaces in the
  //         picker); dimensionDeltaFor(7, 1) === 1 (the match rule).
  // W-7-C: every wired schema's stepIds are unique — a duplicate would make
  //         the stepDone counters (and the payload-matched step) collide.
  it('W-7-A. SCHEMAS.get(7) holds submit/verify/verify-2/settle; both gates plain single checks; verify-2 is a verify op with a DISTINCT stepId', () => {
    const schema = SCHEMAS.get(7);
    expect(schema).toBeDefined();
    expect(schema!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(schema!.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'verify-2', 'settle']);
    const [m1, m2] = schema!.steps.filter((s) => s.op === 'verify_contribution');
    expect(schema!.steps[1].op).toBe('verify_contribution');
    expect(m1.requirement).toEqual({ mode: 'single', count: 1 });
    expect(m1.actors).toEqual(['verifier']);
    expect(m2.stepId).toBe('verify-2');
    expect(m2.requirement).toEqual({ mode: 'single', count: 1 });
    expect(m2.actors).toEqual(['verifier']);
    expect(schema!.steps[3].op).toBe('settle_contribution');
  });

  it('W-7-B. the dim is implemented AND pickable; the match rule is the generic 1', () => {
    expect(DIMENSIONS[7].implemented).toBe(true);
    expect(DIMENSIONS[7].pickable).toBe(true);
    expect(dimensionDeltaFor(7, 1)).toBe(1);
  });

  it('W-7-C. the picker\'s verifiers count derives from the FIRST verify step (1 — one named verifier carries BOTH milestones)', () => {
    const schema = SCHEMAS.get(7)!;
    const firstVerify = schema.steps.find((s) => s.op === 'verify_contribution')!;
    expect(firstVerify.stepId).toBe('verify');
    expect(firstVerify.requirement.count).toBe(1);
  });

  it('W-7-C2. every wired schema has unique stepIds (the per-step done counters must not collide)', () => {
    for (const [dim, schema] of SCHEMAS) {
      const ids = schema.steps.map((s) => s.stepId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(SCHEMAS.has(dim)).toBe(true);
    }
  });
});

describe('C_7 submit: the one named verifier is required up front', () => {
  // Contracts:
  // S-7-A: a valid milestone claim (the verifier named) submits → 0; the
  //        targeted set carries the name; the per-step done counters exist
  //        for BOTH verify stages.
  // S-7-B: an untargeted submission (no verifier named) → -1 — the milestone
  //        claim requires its checker NAMED (the class rule cannot pick one
  //        member for two gates).
  it('S-7-A. a valid claim submits and pins the named verifier; both milestone counters declared', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.state.setContains(STATE_NAMES.contributions, 'c-drive')).toBe(true);
    expect(h.state.setContains(CONTRIB_NAMES.verifiers('c-drive'), 'bob')).toBe(true);
    expect(h.state.getRegister(CONTRIB_NAMES.verifierCount('c-drive'))).toBe(1);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify'))).toBe(0);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify-2'))).toBe(0);
  });

  it('S-7-B. an untargeted milestone claim is rejected (the checker is named up front)', () => {
    const h = arc();
    const { verifiers: _omitted, ...untargeted } = milestoneClaimOp({}) as Partial<ContributionPayload>;
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', untargeted as ContributionPayload))).toBe(-1);
    expect(h.state.setContains(STATE_NAMES.contributions, 'c-drive')).toBe(false);
  });
});

describe('C_7 verify: two gates, credited once at the last', () => {
  // Contracts:
  // M-A: the arc — M1's pass advances the register to M2 and pays NO credit
  //      (the claim is not final); M2's pass (stepId 'verify-2') is the
  //      FINAL verify: the FILER's C_7 tally gains match × alpha FOR ONCE —
  //      the pre-gate check must not have credited (the timing, not the
  //      count, is what milestones shape).
  // M-B: EACH completed check pays the verifying member the standing +2
  //      per-check credit (M1 and M2 alike).
  // M-C: OUT OF ORDER — an attempt to check M2 while the register still sits
  //      at M1 dies -1 with NOTHING moved (the step register gates the
  //      ordering; the payload's 'verify-2' matches no current step yet).
  it('M-A. the arc: M1 advances only; M2 credits the filer exactly once', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    // M1 (the 'verify' step): the pass advances past it, but the milestone
    // claim is NOT final — no tally yet (the credit's timing is M2).
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-drive'))).toBe(2);
    expect(h.tally('alice', 7)).toBe(0);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify'))).toBe(1);
    // M2 (the 'verify-2' step): the SAME verifier's second op is the final
    // gate — the tally fires here, exactly once.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.tally('alice', 7)).toBe(1);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify-2'))).toBe(1);
    // The lifecycle advanced to the settle step, which is NOT terminal yet.
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-drive'))).toBe(3);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-drive'))).toBe(0);
  });

  it('M-B. each milestone check pays the verifying member the standing +2', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.res('bob')).toBe(2);
    expect(h.state.getRegister(CHECK_NAMES.total('bob'))).toBe(1);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.res('bob')).toBe(4);
    expect(h.state.getRegister(CHECK_NAMES.total('bob'))).toBe(2);
  });

  it('M-C. the milestones out of order: an M2 check while the register sits at M1 is rejected — nothing moved', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(-1);
    // All-or-nothing: no per-check credit, no done counter, no step move,
    // no tally, no reciprocity record.
    expect(h.res('bob')).toBe(0);
    expect(h.state.getRegister(CHECK_NAMES.total('bob'))).toBe(0);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify-2'))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-drive'))).toBe(1);
    expect(h.tally('alice', 7)).toBe(0);
    expect(h.state.setContains(RECIP_NAMES.verifiedBy('alice'), 'bob')).toBe(false);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-drive'))).toBe(0);
  });
});

describe('C_7 resolve: the settle step sits at index 3, located by the payload dims', () => {
  // Contracts:
  // M-D: the settle path completes the milestone claim — the settle op must
  //      RE-CARRY dims+schemaVersion (the handler locates the settle step in
  //      the schema instead of pinning register index 2, which only holds
  //      for single-verify schemas); the op finalizes accepted.
  // M-D2: a premature settle (the register not yet at the settle step) → -1;
  //       a MISMATCHED dims re-carry locates a different schema's settle
  //       index → -1 (the re-carry is not a free pass to any position).
  // M-E: the $RES invariant beyond the checks: the filer's balance is
  //      untouched (the classification dim pays no bounty) and the verifier
  //      carries exactly the two check credits.
  it('M-D. the settle path completes: the dims re-carry locates the terminal settle step; status accepted', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.settle(h.state, settleOp('alice', { dims: { '7': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-drive'))).toBe(STATUS_ACCEPTED);
  });

  it('M-D2. a premature settle and a mismatched dims re-carry are both rejected', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    // Premature: the register sits at M1, not at the settle step (index 3).
    expect(h.settle(h.state, settleOp('alice', { dims: { '7': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(-1);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-drive'))).toBe(0);
    // Walk both gates, then settle with a dims re-carry that locates ANOTHER
    // schema's settle index (2 ≠ this record's 3) — rejected for position.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.settle(h.state, settleOp('alice', { dims: { '2': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(-1);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-drive'))).toBe(0);
  });

  it('M-E. the $RES invariant beyond the checks: the filer 0, the verifier exactly +4 for the two checks', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.settle(h.state, settleOp('alice', { dims: { '7': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.res('alice')).toBe(0);
    expect(h.res('bob')).toBe(4);
    expect(h.tally('alice', 7)).toBe(1);
  });
});

describe('C_7 reciprocity: the milestone carve', () => {
  // Contracts:
  // M-F: per-pair once is per-verify-step on a milestone claim — a pair
  //      whose check history already consumed BOTH directions may still walk
  //      the SAME claim's two gates; the SINGLE-verify schema keeps the
  //      standing pair-once bar verbatim (the carve is data-scoped: the
  //      multi-verify schema only).
  it('M-F. a pair whose history is fully consumed may still walk the milestone claim; the single-verify schema stays barred', () => {
    const h = arc();
    // Pre-consume the pair both directions (as earlier arcs of a real DAO
    // would have): bob checked alice before, and alice checked bob before.
    h.state.setAdd(RECIP_NAMES.verifiedBy('alice'), 'bob', 'bob:c-old');
    h.state.setAdd(RECIP_NAMES.verifiedBy('bob'), 'alice', 'alice:c-old');
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    // The milestone claim's gates stay open for the named verifier.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.tally('alice', 7)).toBe(1);
    // A fresh single-verify claim with the SAME consumed pair (bob named):
    // the standing per-pair-once bar holds verbatim — the carve is
    // data-scoped to the multi-verify schema only.
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', submitOp({
      contributionId: 'c-record', dims: { '2': 1 },
    })))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { contributionId: 'c-record', dims: { '2': 1 } }))).toBe(-1);
    // All-or-nothing: nothing moved on the barred check.
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-record', 'verify'))).toBe(0);
  });
});

describe('C_7 appeal: the rewind covers BOTH gates', () => {
  // Contracts:
  // M-G: a rejection at M2 rewinds the register to M1's index AND clears
  //      BOTH milestone counters — the re-review re-walks the full fresh
  //      quorum (a stale M2 counter would pre-satisfy the second gate from
  //      the pre-appeal check). The appeal payload re-carries dims+schema
  //      like the verify payload does.
  it('M-G. the appeal on a milestone claim rewinds to M1 and resets both counters; the re-review re-walks both gates (credited once)', () => {
    const h = arc();
    expect(h.submit(h.state, makeOp('submit_contribution', 'alice', milestoneClaimOp({})))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    // M2 REJECTS — the lifecycle terminates (the pre-appeal verdict paid its
    // per-check credit but credited no tally).
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2', pass: false, reason: 'the second milestone is not met' }))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.status('c-drive'))).toBe(2);
    expect(h.tally('alice', 7)).toBe(0);
    // The appeal (the filer's, dims re-carried): the register rewinds to M1
    // AND the M2 counter — which the rejected check incremented — resets.
    expect(h.appeal(h.state, appealOp('alice', { dims: { '7': 1 }, schemaVersion: SCHEMA_VERSION }))).toBe(0);
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-drive'))).toBe(1);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify'))).toBe(0);
    expect(h.state.getPNCounter(CONTRIB_NAMES.stepDone('c-drive', 'verify-2'))).toBe(0);
    // The re-review re-walks BOTH gates fresh — and the filer's tally still
    // credits exactly once across the whole claim's lifetime.
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify' }))).toBe(0);
    expect(h.verify(h.state, verifyOp('bob', { stepId: 'verify-2' }))).toBe(0);
    expect(h.tally('alice', 7)).toBe(1);
    expect(h.state.getRegister(CONTRIB_NAMES.step('c-drive'))).toBe(3);
  });
});
