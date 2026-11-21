// C_15 Devil (slice #6f) — the claim family's third gate shape: corroboration
// + the symmetric penalty. The exposure claim carries NO tie fields — the
// corroboration IS the gate (two NAMED corroborators, the existing all-parties
// count-2 verify machinery, the #4c targeted set riding the submit), the
// credit is the FILER's C_15 tally, and the PENALTY GATEWAY pays the mirror
// image: the claim's final REJECT decrements the filer's dim-15 tally by
// match × alphaFor(15) — the same per-mille accumulate with a negative delta.
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import {
  DIMENSIONS,
  SCHEMA_VERSION,
  SCHEMAS,
  STATUS_ACCEPTED,
  STATUS_REJECTED,
  dimensionDeltaFor,
  fromRegisterUnits,
  toRegisterUnits,
} from '../../shared/src/contribution';
import {
  makeSettleContributionHandler,
  makeSubmitContributionHandler,
  makeVerifyContributionHandler,
} from '../../shared/src/handlers';
import { CHECK_NAMES, CONTRIB_NAMES, RECIP_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
import {
  ContributionPayload,
  SettleContributionPayload,
  VerifyContributionPayload,
} from '../../shared/src/types';

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

// Contracts:
// W-15-A: SCHEMAS.get(15) exists; steps are submit/verify/settle with the
//         verify step riding the all-parties count-2 shape (the corroboration
//         IS the gate); DIMENSIONS[15].implemented AND pickable (the exposure
//         surfaces as its own claim type).
// W-15-B: dimensionDeltaFor(15, 1) === 1 (the match rule — the WEIGHT lives at
//         the call site, never in this fn).
describe('the C_15 schema is wired (exposure, slice #6f)', () => {
  it('W-15-A. SCHEMAS.get(15) holds submit/verify/settle with the all-parties count-2 verify; the dim is implemented AND pickable', () => {
    const schema = SCHEMAS.get(15);
    expect(schema).toBeDefined();
    expect(schema!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(schema!.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']);
    expect(schema!.steps[1].requirement).toEqual({ mode: 'all-parties', count: 2 });
    expect(DIMENSIONS[15].implemented).toBe(true);
    expect(DIMENSIONS[15].pickable).toBe(true);
  });

  it('W-15-B. the match rule: dimensionDeltaFor(15, 1) === 1 — the WEIGHT lives at the call site', () => {
    expect(dimensionDeltaFor(15, 1)).toBe(1);
    expect(dimensionDeltaFor(15, 0.5)).toBe(0.5);
  });

  it('W-15-C. the per-mille accumulate stays sign-correct on negative deltas (toRegisterUnits/fromRegisterUnits)', () => {
    expect(toRegisterUnits(-1)).toBe(-1000);
    expect(fromRegisterUnits(-1000)).toBe(-1);
    expect(toRegisterUnits(-0.75)).toBe(-750);
    // Crossing a scale boundary in the accumulate: 0.5 + (-1) → -0.5, no
    // read-scale-write drift (the handler adds register units directly).
    expect(500 + toRegisterUnits(-1)).toBe(-500);
  });
});

// Shared fixture idioms (matching c19-recognition.test.ts): real handlers
// only so every arc's registers are handler-stamped.
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

// The exposure claim's submit payload (C_15): NO tie fields — the two NAMED
// corroborators are the claim's whole gate.
function exposeClaimOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return submitOp({
    contributionId: 'c-expose',
    dims: { '15': 1 },
    summary: 'exposure: a skewed incentive named',
    verifiers: ['bob', 'carol'],
    ...payload,
  } as Partial<ContributionPayload>);
}

function submitOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return {
    contributionId: 'c-1',
    dims: { '2': 1 },
    summary: 'Wrote an architecture record',
    evidenceRef: GOOD_REF,
    schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as ContributionPayload;
}

function verifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
  return makeOp('verify_contribution', signer, {
    contributionId: 'c-expose', submitter: 'alice', dims: { '15': 1 }, stepId: 'verify',
    pass: true, reason: 'checks out', schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as VerifyContributionPayload);
}

describe('C_15 submit: the corroborators are named up front; no ties', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
  });

  // Contracts:
  // S-15-A: alice submits a valid C_15 claim naming TWO corroborators → 0;
  //         the submit carries verifiers (the #4c targeted set) + no tie
  //         stamps (the claim has none).
  // S-15-B: an UNTARGETED submission (verifiers absent) → -1 — the
  //         corroboration gate requires the corroborators NAMED at submit.
  // S-15-C: a corroborator count other than the schema's exact 2 → -1
  //         (the #4c count-exact leg rides).
  // S-15-D: a claim-payload hybrid (a dim-15 payload also naming a C_19 tie)
  //         → -1 — every claim rides exactly one wired claim schema.
  it('S-15-A. a valid claim submits and pins the two named corroborators on the targeted set', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', exposeClaimOp({})))).toBe(0);
    expect(state.setContains(STATE_NAMES.contributions, 'c-expose')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-expose'), 'bob')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-expose'), 'carol')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-expose'))).toBe(2);
    // No tie sets on a tie-free claim: the claim's recognized/taught sets hold
    // nothing (its rule stamps nothing).
    expect(state.setContains(CONTRIB_NAMES.recognized('c-expose'), 'bob')).toBe(false);
    expect(state.setContains(CONTRIB_NAMES.taught('c-expose'), 'bob')).toBe(false);
  });

  it('S-15-B. an untargeted submission (no corroborators named) is rejected', () => {
    const { verifiers: _omitted, ...untargeted } = exposeClaimOp({}) as Partial<ContributionPayload>;
    expect(submit(state, makeOp('submit_contribution', 'alice', untargeted as ContributionPayload))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-expose')).toBe(false);
  });

  it('S-15-C. a corroborator count other than the schema’s exact 2 is rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', exposeClaimOp({ verifiers: ['bob'] })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-expose')).toBe(false);
  });

  it('S-15-D. a dim hybrid (15 + 19 with a recognition tie) is rejected — one claim schema per payload', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', exposeClaimOp({
      dims: { '15': 1, '19': 1 }, recognized: 'bob', recordId: 'c-work',
    })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-expose')).toBe(false);
  });
});

describe('C_15 verify: the corroborated credit + the symmetric penalty gateway', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let verify: (state: HandlerState, op: HandlerOperation) => number;
  let settle: (state: HandlerState, op: HandlerOperation) => number;
  let tally: (username: string, dimIndex: number) => number;
  let res: (username: string) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
    tally = (username, dimIndex) => fromRegisterUnits(state.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex)));
    res = (username) => fromRegisterUnits(state.getRegister(RES_NAMES.balance(username)));
  });

  // alice's exposure claim naming bob + carol (the machine's targeted set).
  function claimArc(): void {
    expect(submit(state, makeOp('submit_contribution', 'alice', exposeClaimOp({})))).toBe(0);
  }

  // Contracts:
  // G-15-E: the unnamed-corroborator rejection rides the #4c targeted gate —
  //         a member the submit did NOT name may neither pass nor reject a C_15
  //         claim; -1 with NOTHING moved (no per-check credit, no guard set, no
  //         stepDone, no tally/penalty).
  // F-C: a HALF-corroborated claim — the first named pass completes 1 of 2,
  //      the step is NOT final: no credit yet, the lifecycle holds at verify.
  // F-A: the happy arc — both named corroborators uphold (the all-parties
  //      quorum completes at the SECOND pass) → the FILER's C_15 tally gains
  //      match × alphaFor(15); the corroborators earn nothing on the claim's
  //      dim; the claim advances to settle.
  it('G-15-E. the unnamed gate: a pass from a member the submit did NOT name is rejected — nothing moved', () => {
    claimArc();
    expect(verify(state, verifyOp('dave', { priorVerifiers: [] }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(state.getRegister(CHECK_NAMES.total('dave'))).toBe(0);
    expect(state.setContains(RECIP_NAMES.verifiedBy('alice'), 'dave')).toBe(false);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-expose', 'verify'))).toBe(0);
    expect(tally('alice', 15)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-expose'))).toBe(0);
  });

  it('F-C. a HALF-corroborated claim: the first named pass is not final — no credit, the lifecycle holds at verify', () => {
    claimArc();
    expect(verify(state, verifyOp('bob', { priorVerifiers: [] }))).toBe(0);
    expect(tally('alice', 15)).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-expose', 'verify'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.step('c-expose'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.status('c-expose'))).toBe(0);
    // One corroborator's check is completed but does not pay the claim's
    // credit (the all-parties quorum is 2).
    expect(tally('bob', 15)).toBe(0);
  });

  it('F-A. the happy arc (unset alpha): BOTH corroborators uphold — the FILER’s C_15 tally gains match × 1', () => {
    claimArc();
    expect(verify(state, verifyOp('bob', { priorVerifiers: [] }))).toBe(0);
    expect(verify(state, verifyOp('carol', { priorVerifiers: ['bob'] }))).toBe(0);
    // The FILER's tally: match 1 × alphaFor(15) unset → 1 — the claim-gate
    // map's filer credit (C_5's recipient shape; C_19's is the recognized).
    expect(tally('alice', 15)).toBe(1);
    // The corroborators earn nothing on the claim's dim (their per-check $RES
    // credit is the generic C_18 rule, separate).
    expect(tally('bob', 15)).toBe(0);
    expect(tally('carol', 15)).toBe(0);
    // The lifecycle advanced to settle, like every schema.
    expect(state.getRegister(CONTRIB_NAMES.step('c-expose'))).toBe(2);
    // $RES invariant: no bounty fires on the classification dim — the filer's
    // balance is untouched by the claim's verification.
    expect(res('alice')).toBe(0);
  });

  it('F-A (scaled). alphaFor(15) seeded to 2: the SAME arc credits the filer match × 2', () => {
    state.setRegister('config:alpha:15', toRegisterUnits(2), 'custodian');
    claimArc();
    expect(verify(state, verifyOp('bob', { priorVerifiers: [] }))).toBe(0);
    expect(verify(state, verifyOp('carol', { priorVerifiers: ['bob'] }))).toBe(0);
    expect(tally('alice', 15)).toBe(2);
  });

  it('F-A (settle). the settled claim finalizes accepted; the tally holds — no money moves', () => {
    claimArc();
    expect(verify(state, verifyOp('bob', { priorVerifiers: [] }))).toBe(0);
    expect(verify(state, verifyOp('carol', { priorVerifiers: ['bob'] }))).toBe(0);
    const aliceBefore = res('alice');
    expect(settle(state, makeOp('settle_contribution', 'alice', {
      contributionId: 'c-expose', submitter: 'alice', reason: 'the exposure stands',
    } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-expose'))).toBe(STATUS_ACCEPTED);
    expect(tally('alice', 15)).toBe(1);
    expect(res('alice')).toBe(aliceBefore);
  });

  // THE PENALTY: the reject path of the verify handler — where the machine
  // currently credits nothing. A completed rejection IS the C_15 claim's
  // final resolution (a rejection terminates the lifecycle immediately), so
  // the FILER's dim-15 tally takes the NEGATIVE delta.
  // Contracts:
  // F-B: the named corroborator's reject → the filer's C_15 tally −match ×
  //      alphaFor(15); the claim terminates rejected; the rejecter still
  //      earns the generic per-check credit (the tally penalty and the check
  //      credit are separate rules).
  it('F-B. the penalty gateway: a named corroborator’s REJECT decrements the FILER’s C_15 tally by match × 1', () => {
    claimArc();
    expect(verify(state, verifyOp('bob', { pass: false, priorVerifiers: [], reason: 'the exposure is disproven' }))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-expose'))).toBe(STATUS_REJECTED);
    // The symmetric negative: prev 0 + (−match × alphaFor(15)) → −1.
    expect(tally('alice', 15)).toBe(-1);
    // The rejecter's per-check credit still fired (the generic C_18 rule
    // pays either direction) — the penalty and the check credit are separate.
    expect(res('bob')).toBe(2);
    // $RES invariant (F-D): the penalty is credibility-only — the filer's
    // $RES is untouched.
    expect(res('alice')).toBe(0);
  });

  it('F-B (scaled). alphaFor(15) seeded to 2: the SAME reject decrements by match × 2', () => {
    state.setRegister('config:alpha:15', toRegisterUnits(2), 'custodian');
    claimArc();
    expect(verify(state, verifyOp('bob', { pass: false, priorVerifiers: [], reason: 'the exposure is disproven' }))).toBe(0);
    expect(tally('alice', 15)).toBe(-2);
  });

  it('F-B (accumulate). a pre-existing positive tally crosses the scale: 0.5 + (−1) → −0.5', () => {
    // The per-mille accumulate rides the same prev + toRegisterUnits(delta)
    // idiom with a negative delta — a half-earned prior tally goes negative
    // without read-scale-write drift.
    state.setRegister(CONTRIB_NAMES.dimensionBalance('alice', 15), toRegisterUnits(0.5), 'custodian');
    claimArc();
    expect(verify(state, verifyOp('bob', { pass: false, priorVerifiers: [], reason: 'the exposure is disproven' }))).toBe(0);
    expect(fromRegisterUnits(state.getRegister(CONTRIB_NAMES.dimensionBalance('alice', 15)))).toBe(-0.5);
  });

  it('F-B (gate). the unnamed member may not trigger the penalty either — the reject dies at the targeted gate', () => {
    claimArc();
    expect(verify(state, verifyOp('dave', { pass: false, priorVerifiers: [], reason: 'not my call' }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(state.getRegister(CHECK_NAMES.total('dave'))).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-expose', 'verify'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-expose'))).toBe(0);
    expect(tally('alice', 15)).toBe(0);
  });

  it('F-B (negative space). a rejected C_19 claim still touches nothing — the penalty is the 15-rule’s alone', () => {
    // Pre-#6f negative space byte-preserved: the C_19 claim's reject leaves
    // every tally register untouched (the reject path still credits nothing
    // for rules without the penalty gateway).
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({ contributionId: 'c-work' })))).toBe(0);
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({
      contributionId: 'c-claim', dims: { '19': 1 }, summary: 'recognition: bob’s work',
      recognized: 'bob', recordId: 'c-work',
    })))).toBe(0);
    expect(verify(state, verifyOp('carol', {
      contributionId: 'c-claim', dims: { '19': 1 }, pass: false,
      reason: 'not this one', recognized: 'bob', recordId: 'c-work',
    }))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(STATUS_REJECTED);
    expect(tally('alice', 15)).toBe(0);
    expect(tally('bob', 19)).toBe(0);
    expect(tally('alice', 19)).toBe(0);
  });
});
