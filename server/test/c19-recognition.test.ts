// C_19 recognition (slice #6a) + C_5 teaching (slice #6e) — the claim
// contracts. Recognition became the first claim-type: the dim-19 schema is
// wired, and its payload carries the tie fields the machine validates through
// the submit/verify lifecycle. Teaching generalizes the machinery into its
// first other-shape (the claim-gate map): the tie sharpens on the OWNER set —
// the linked record must be authored by the TAUGHT member — and the FILER's
// C_5 tally takes the credit (the C_19 branch credits the recognized).
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import {
  DIMENSIONS,
  SCHEMA_VERSION,
  SCHEMAS,
  STATUS_ACCEPTED,
  dimensionDeltaFor,
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
    const tag = this.setTags.get(name)?.get(element);
    return this.setContains(name, element) && tag ? [tag] : [];
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
// W-A: SCHEMAS.get(19) exists; steps are submit/verify/settle with the
//      verify step's actors ['verifier'] + requirement single/1;
//      DIMENSIONS[19].implemented === true.
// W-B: dimensionDeltaFor(19, 1) === 1 (the match rule — the WEIGHT lives at
//      the call site, never in this fn).
describe('the C_19 schema is wired (recognition, slice #6a)', () => {
  let node: MockNode;
  let state: MockState;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    void state; // consumed by the lifecycle suites appended in later tasks
  });

  it('W-A. SCHEMAS.get(19) holds the submit/verify/settle schema; the dim is implemented', () => {
    const schema = SCHEMAS.get(19);
    expect(schema).toBeDefined();
    expect(schema!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(schema!.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']);
    expect(schema!.steps[1].actors).toEqual(['verifier']);
    expect(schema!.steps[1].requirement).toEqual({ mode: 'single', count: 1 });
    expect(DIMENSIONS[19].implemented).toBe(true);
  });

  it('W-B. the match rule: dimensionDeltaFor(19, 1) === 1 — the WEIGHT lives at the call site', () => {
    expect(dimensionDeltaFor(19, 1)).toBe(1);
    expect(dimensionDeltaFor(19, 0.5)).toBe(0.5);
  });
});

// Shared fixture idioms (matching targeted-verification.test.ts): real
// handlers only so every arc's registers are handler-stamped.
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
    contributionId: 'c-1',
    dims: { '2': 1 },
    summary: 'Wrote an architecture record',
    evidenceRef: GOOD_REF,
    schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as ContributionPayload;
}

function claimOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return submitOp({
    contributionId: 'c-claim',
    dims: { '19': 1 },
    summary: 'recognition: bob’s proven work',
    recognized: 'bob',
    recordId: 'c-work',
    ...payload,
  } as Partial<ContributionPayload>);
}

// The teaching claim's submit payload (C_5): the taught member + the tied
// record — the pair the machine validates and stamps on both lifecycle ops.
function teachClaimOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return submitOp({
    contributionId: 'c-teach',
    dims: { '5': 1 },
    summary: 'teaching: bob’s demonstrated competence',
    taught: 'bob',
    recordId: 'c-work',
    ...payload,
  } as Partial<ContributionPayload>);
}

function verifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
  return makeOp('verify_contribution', signer, {
    contributionId: 'c-claim', submitter: 'alice', dims: { '19': 1 }, stepId: 'verify',
    pass: true, reason: 'checks out', schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as VerifyContributionPayload);
}

// The teaching claim's verify op: the re-carried ties (taught + recordId) ride
// every pass — the gate pins them against the claim's stamps (a renamed or
// absent re-carry is a forged tie).
function teachVerifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
  return makeOp('verify_contribution', signer, {
    contributionId: 'c-teach', submitter: 'alice', dims: { '5': 1 }, stepId: 'verify',
    pass: true, reason: 'checks out', schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as VerifyContributionPayload);
}

describe('C_19 submit: the claim validates its ties and stamps the registers', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let verify: (state: HandlerState, op: HandlerOperation) => number;
  let settle: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // Members set seeded with add_member semantics (element = username).
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
  });

  // The tie's record: bob's C_2 record submitted untargeted, verified by
  // carol, settled by bob — an ACCEPTED contribution (real handlers only).
  function acceptedRecordArc(contributionId = 'c-work'): void {
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({ contributionId })))).toBe(0);
    expect(verify(state, verifyOp('carol', { contributionId, submitter: 'bob', dims: { '2': 1 } }))).toBe(0);
    expect(settle(state, makeOp('settle_contribution', 'bob', {
      contributionId, submitter: 'bob', reason: 'the record is real',
    } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status(contributionId))).toBe(STATUS_ACCEPTED);
  }

  // Contracts:
  // S-A: alice submits a valid C_19 claim (recognized: bob, recordId: an
  //      ACCEPTED contribution) → 0; the registers hold recognized=bob
  //      (setContains) and the tie (setContains(recordTie, recordId)).
  // S-B: recognized === op.signerId (self-recognition) → -1.
  // S-C: recognized not a member → -1.
  // S-D: recordId not an existing contribution → -1.
  it('S-A. a valid claim submits and stamps recognized + recordTie on its registers', () => {
    acceptedRecordArc();
    expect(submit(state, makeOp('submit_contribution', 'alice', claimOp({})))).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.recognized('c-claim'), 'bob')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.recordTie('c-claim'), 'c-work')).toBe(true);
    // The claim itself entered the machine like every submission.
    expect(state.setContains(STATE_NAMES.contributions, 'c-claim')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(0);
  });

  it('S-B. a self-recognition (recognized === the submitter) is rejected', () => {
    acceptedRecordArc();
    expect(submit(state, makeOp('submit_contribution', 'alice', claimOp({ recognized: 'alice' })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-claim')).toBe(false);
  });

  it('S-C. a recognized non-member is rejected', () => {
    acceptedRecordArc();
    expect(submit(state, makeOp('submit_contribution', 'alice', claimOp({ recognized: 'ghost' })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-claim')).toBe(false);
  });

  it('S-D. a tie to a non-existent record is rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', claimOp({ recordId: 'c-ghost' })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-claim')).toBe(false);
  });
});

describe('C_19 verify: the tie gate + the recognized member’s tally credit', () => {
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
    tally = (username, dimIndex) => state.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex));
    res = (username) => state.getRegister(RES_NAMES.balance(username));
  });

  // bob's tied record, ACCEPTED by the real handlers (submit → verify → settle).
  function acceptedRecordArc(contributionId = 'c-work'): void {
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({ contributionId })))).toBe(0);
    expect(verify(state, verifyOp('carol', { contributionId, submitter: 'bob', dims: { '2': 1 } }))).toBe(0);
    expect(settle(state, makeOp('settle_contribution', 'bob', {
      contributionId, submitter: 'bob', reason: 'the record is real',
    } as SettleContributionPayload))).toBe(0);
  }

  // alice's claim recognizing bob, tied to the accepted record.
  function claimArc(recordId = 'c-work'): void {
    acceptedRecordArc(recordId);
    expect(submit(state, makeOp('submit_contribution', 'alice', claimOp({ recordId })))).toBe(0);
  }

  // Contracts:
  // G-A: the GATE — a pass on a C_19 claim whose verify payload's recordId
  //      holds a NON-accepted record (pending fixture) → -1, NOTHING recorded.
  // G-B: the verify payload missing recordId on a C_19 claim → -1.
  // G-C: the happy arc — a named pass credits the RECOGNIZED member's C_19
  //      tally by match × alphaFor(19) (unset alpha = match; seeded alpha =
  //      the scaled value); the submitter earns nothing.
  // G-D: the settle step completes the shape like every schema.
  it('G-A. the gate: a pass whose recordId points at a NON-accepted record is rejected — nothing recorded', () => {
    // The tie's record exists but never settled: its status stays PENDING.
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({ contributionId: 'c-work' })))).toBe(0);
    expect(submit(state, makeOp('submit_contribution', 'alice', claimOp({})))).toBe(0);
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'bob' }))).toBe(-1);
    // Nothing mutated: the verifier paid no per-check credit and the verify
    // never completed.
    expect(res('dave')).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-claim', 'verify'))).toBe(0);
    expect(tally('bob', 19)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(0);
  });

  it('G-B. the C_19 pass gate: the verify payload missing recordId is rejected', () => {
    claimArc();
    expect(verify(state, verifyOp('dave', { recognized: 'bob' }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(tally('bob', 19)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(0);
  });

  // Contracts:
  // G-E: the PIN — a pass whose payload's recordId is NOT the claim's stamped
  //      tie (a DIFFERENT accepted record — it clears the status check) → -1,
  //      nothing recorded. The credit follows the claim's record, not the
  //      verifier's payload.
  // G-F: the same pin on the recognized member — a pass renaming the
  //      credit's recipient (a valid member ≠ the submitter) → -1.
  it('G-E. the tie pin: a pass naming a DIFFERENT (accepted) record than the claim’s stamp is rejected', () => {
    claimArc();
    // A second ACCEPTED record of bob's (verifier alice — carol's pair with
    // bob was consumed by the first arc): it clears the status check, so this
    // pass is isolated to the pin, not to the gate's status leg.
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({ contributionId: 'c-other' })))).toBe(0);
    expect(verify(state, verifyOp('alice', { contributionId: 'c-other', submitter: 'bob', dims: { '2': 1 } }))).toBe(0);
    expect(settle(state, makeOp('settle_contribution', 'bob', {
      contributionId: 'c-other', submitter: 'bob', reason: 'the record is real',
    } as SettleContributionPayload))).toBe(0);
    expect(verify(state, verifyOp('dave', { recordId: 'c-other', recognized: 'bob' }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(tally('bob', 19)).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-claim', 'verify'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(0);
  });

  it('G-F. the recognized pin: a pass renaming the credited member is rejected', () => {
    claimArc();
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'carol' }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(tally('carol', 19)).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-claim', 'verify'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(0);
  });

  // Contracts:
  // PIN-C: the owner pin — the verify payload's `submitter` claim is a
  // re-carry, not the truth: the handler machine-checks it against the
  // submit-stamped owner set (the stamps are the referee, the same read
  // settle/appeal/reassign do). A pass whose claim names a DIFFERENT member
  // → -1 + NOTHING moved (no per-check credit, no accuracy accrual, no
  // reciprocity guard set, no stepDone, no tally). Asserted BOTH directions:
  // the forged spread fails with nothing moved; the true owner's spread
  // passes.
  it('PIN-C. the owner pin: a pass FORGING the submitter claim is rejected — nothing moved; the true owner’s spread passes', () => {
    claimArc();
    // carol is a member and ≠ the signer dave — the forgery dies ONLY at the
    // owner stamp, not at any membership/self-verify tier.
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'bob', submitter: 'carol' }))).toBe(-1);
    expect(res('dave')).toBe(0); // no per-check credit
    expect(state.getRegister(CHECK_NAMES.total('dave'))).toBe(0); // no accuracy accrual
    expect(state.setContains(RECIP_NAMES.verifiedBy('carol'), 'dave')).toBe(false); // no reciprocity record
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-claim', 'verify'))).toBe(0);
    expect(tally('carol', 19)).toBe(0);
    expect(tally('bob', 19)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(0);
    // The true owner's spread (alice stamped the claim's owner set) passes.
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'bob' }))).toBe(0);
    expect(tally('bob', 19)).toBe(toRegisterUnits(1));
  });

  it('G-C. the happy arc (unset alpha): the RECOGNIZED member gains match × 1; the submitter earns nothing on C_19', () => {
    claimArc();
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'bob' }))).toBe(0);
    // The default weight: match 1 × alphaFor(19) = 1 — in register units.
    expect(tally('bob', 19)).toBe(toRegisterUnits(1));
    // The claim's own lifecycle advanced to settle, like every schema.
    expect(state.getRegister(CONTRIB_NAMES.step('c-claim'))).toBe(2);
    // No $RES moved: the submitter earns nothing on C_19 — no bounty fires
    // (the verifier's per-check +2 is dave's, separate).
    // No $RES moved: the submitter earns nothing on C_19 — no bounty fires
    // (the verifier's per-check +2 is dave's, separate). Balances are read
    // BEFORE the claim's verify: only the C_19 pass is under test here.
    const aliceBefore = res('alice');
    const bobBefore = res('bob');
    expect(bobBefore).toBe(toRegisterUnits(3)); // bob's own C_2 bounty — unchanged by the claim
    expect(res('alice')).toBe(aliceBefore);
    expect(res('bob')).toBe(bobBefore);
    expect(tally('alice', 19)).toBe(0);
  });

  it('G-C (scaled). alphaFor(19) seeded to 2: the SAME arc credits the recognized member match × 2', () => {
    state.setRegister('config:alpha:19', toRegisterUnits(2), 'custodian');
    claimArc();
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'bob' }))).toBe(0);
    expect(tally('bob', 19)).toBe(toRegisterUnits(1 * 2));
    expect(state.getRegister(CONTRIB_NAMES.step('c-claim'))).toBe(2);
  });

  it('G-D. the settle step completes the arc like every schema; no money moves', () => {
    claimArc();
    expect(verify(state, verifyOp('dave', { recordId: 'c-work', recognized: 'bob' }))).toBe(0);
    const aliceBefore = res('alice');
    const bobBefore = res('bob');
    expect(settle(state, makeOp('settle_contribution', 'alice', {
      contributionId: 'c-claim', submitter: 'alice', reason: 'the tie is real',
    } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-claim'))).toBe(1);
    expect(res('alice')).toBe(aliceBefore);
    expect(res('bob')).toBe(bobBefore);
    expect(tally('bob', 19)).toBe(toRegisterUnits(1));
  });
});

// --- C_5 teaching (slice #6e): the claim-gate map's first other-shape ---

describe('the C_5 schema is wired (teaching, slice #6e)', () => {
  it('W-5-A. SCHEMAS.get(5) holds the submit/verify/settle schema; the dim is implemented AND pickable', () => {
    const schema = SCHEMAS.get(5);
    expect(schema).toBeDefined();
    expect(schema!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(schema!.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']);
    expect(schema!.steps[1].actors).toEqual(['verifier']);
    expect(schema!.steps[1].requirement).toEqual({ mode: 'single', count: 1 });
    expect(DIMENSIONS[5].implemented).toBe(true);
    expect(DIMENSIONS[5].pickable).toBe(true);
  });

  it('W-5-B. the match rule: dimensionDeltaFor(5, 1) === 1 — the WEIGHT lives at the call site', () => {
    expect(dimensionDeltaFor(5, 1)).toBe(1);
    expect(dimensionDeltaFor(5, 0.5)).toBe(0.5);
  });
});

describe('C_5 submit: the claim validates its ties and stamps the registers', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let verify: (state: HandlerState, op: HandlerOperation) => number;
  let settle: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // erin: the THIRD member — the tie-owner mismatch's record author (the
    // demonstration's tie must be the taught member's work, so a record
    // authored by anyone else is the machine's mismatch case).
    for (const u of ['alice', 'bob', 'carol', 'dave', 'erin']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
  });

  // The tie's record: `author`'s C_2 record verified by `verifier`, settled by
  // the author — an ACCEPTED contribution (real handlers only; the pair
  // author↔verifier must be fresh, and is inside each arc).
  function acceptedRecordArc(contributionId = 'c-work', author = 'bob', verifier = 'carol'): void {
    expect(submit(state, makeOp('submit_contribution', author, submitOp({ contributionId })))).toBe(0);
    expect(verify(state, verifyOp(verifier, { contributionId, submitter: author, dims: { '2': 1 } }))).toBe(0);
    expect(settle(state, makeOp('settle_contribution', author, {
      contributionId, submitter: author, reason: 'the record is real',
    } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status(contributionId))).toBe(STATUS_ACCEPTED);
  }

  // Contracts:
  // S-5-A: alice submits a valid C_5 claim (taught: bob, recordId: an existing
  //        contribution) → 0; the registers hold taught=bob (setContains) and
  //        the tie (setContains(recordTie, recordId)).
  // S-5-B: taught === op.signerId (self-taught) → -1.
  // S-5-C: taught not a member → -1.
  // S-5-D: recordId not an existing contribution → -1.
  it('S-5-A. a valid claim submits and stamps taught + recordTie on its registers', () => {
    acceptedRecordArc();
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({})))).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.taught('c-teach'), 'bob')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.recordTie('c-teach'), 'c-work')).toBe(true);
    // The claim itself entered the machine like every submission.
    expect(state.setContains(STATE_NAMES.contributions, 'c-teach')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.status('c-teach'))).toBe(0);
  });

  it('S-5-B. a self-taught claim (taught === the filer) is rejected', () => {
    acceptedRecordArc();
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({ taught: 'alice' })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-teach')).toBe(false);
  });

  it('S-5-C. a taught non-member is rejected', () => {
    acceptedRecordArc();
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({ taught: 'ghost' })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-teach')).toBe(false);
  });

  it('S-5-D. a tie to a non-existent record is rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({ recordId: 'c-ghost' })))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-teach')).toBe(false);
  });
});

describe('C_5 verify: the owner-pinned tie gate + the filer’s tally credit', () => {
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
    // erin: the third member's authored record is the tie-owner mismatch case.
    for (const u of ['alice', 'bob', 'carol', 'dave', 'erin']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
    tally = (username, dimIndex) => state.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex));
    res = (username) => state.getRegister(RES_NAMES.balance(username));
  });

  // `author`'s C_2 record, ACCEPTED by the real handlers (submit → verify →
  // settle); the author↔verifier pair must be fresh, and is per call.
  function acceptedRecordArc(contributionId = 'c-work', author = 'bob', verifier = 'carol'): void {
    expect(submit(state, makeOp('submit_contribution', author, submitOp({ contributionId })))).toBe(0);
    expect(verify(state, verifyOp(verifier, { contributionId, submitter: author, dims: { '2': 1 } }))).toBe(0);
    expect(settle(state, makeOp('settle_contribution', author, {
      contributionId, submitter: author, reason: 'the record is real',
    } as SettleContributionPayload))).toBe(0);
  }

  // alice's teaching claim naming `taught`, tied to the record.
  function claimArc(recordId = 'c-work', taught = 'bob'): void {
    acceptedRecordArc(recordId, taught, 'carol');
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({ recordId, taught })))).toBe(0);
  }

  // Contracts:
  // G-5-A: the GATE — a pass whose verify payload's recordId holds a
  //        NON-accepted record (pending fixture) → -1, NOTHING recorded.
  // G-5-B: the OWNER pin — a pass whose tied record is accepted but authored
  //        by ANOTHER member (erin's, taught: bob) → -1: the demonstration's
  //        proven work must belong to the student.
  // G-5-C: the re-carry PIN — a pass renaming the taught member (or omitting
  //        the re-carry entirely) is a forged tie → -1, nothing moved; the
  //        true re-carry passes both directions.
  // G-5-D: the happy arc (unset alpha) — the FILER's C_5 tally gains match × 1
  //        (the teacher's demonstrated-teaching tally); the student earns
  //        nothing; NO $RES moves (no bounty fires on the classification dim).
  // G-5-E: alphaFor(5) seeded to 2 → the SAME arc credits the filer match × 2.
  // G-5-F: the settle step completes the shape like every schema; no money.
  it('G-5-A. the gate: a pass whose recordId points at a NON-accepted record is rejected — nothing recorded', () => {
    // The tie's record exists but never settled: its status stays PENDING.
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({ contributionId: 'c-work' })))).toBe(0);
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({})))).toBe(0);
    expect(verify(state, teachVerifyOp('dave', { taught: 'bob', recordId: 'c-work' }))).toBe(-1);
    // Nothing mutated: the verifier paid no per-check credit and the verify
    // never completed.
    expect(res('dave')).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-teach', 'verify'))).toBe(0);
    expect(tally('alice', 5)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-teach'))).toBe(0);
  });

  it('G-5-B. the owner pin: a pass whose tied record was authored by ANOTHER member is rejected', () => {
    // erin's ACCEPTED record passes the status leg, so this pass is isolated
    // to the tie-must-be-the-student's-work leg (the owner-set pin).
    acceptedRecordArc('c-erins', 'erin', 'bob');
    // Submit only pins the tie's EXISTENCE (the #6a pattern) — the owner
    // mismatch is the verify gate's machine-check.
    expect(submit(state, makeOp('submit_contribution', 'alice', teachClaimOp({ recordId: 'c-erins' })))).toBe(0);
    expect(verify(state, teachVerifyOp('dave', { taught: 'bob', recordId: 'c-erins' }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(tally('alice', 5)).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-teach', 'verify'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-teach'))).toBe(0);
  });

  it('G-5-C. the re-carry pin: a pass renaming (or omitting) the taught member is rejected — the true re-carry passes', () => {
    claimArc();
    // carol is a member and ≠ the filer alice — the forgery dies ONLY at the
    // taught stamp, not at any membership/self tier.
    expect(verify(state, teachVerifyOp('dave', { taught: 'carol', recordId: 'c-work' }))).toBe(-1);
    expect(verify(state, teachVerifyOp('dave', { recordId: 'c-work' }))).toBe(-1);
    expect(res('dave')).toBe(0);
    expect(tally('carol', 5)).toBe(0);
    expect(tally('alice', 5)).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-teach', 'verify'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-teach'))).toBe(0);
    // The true re-carry (the claim's stamped taught set) passes.
    expect(verify(state, teachVerifyOp('dave', { taught: 'bob', recordId: 'c-work' }))).toBe(0);
    expect(tally('alice', 5)).toBe(toRegisterUnits(1));
  });

  it('G-5-D. the happy arc (unset alpha): the FILER’s C_5 tally gains match × 1; the student earns nothing; no $RES moves', () => {
    claimArc();
    expect(verify(state, teachVerifyOp('dave', { taught: 'bob', recordId: 'c-work' }))).toBe(0);
    // The default weight: match 1 × alphaFor(5) = 1 — in register units.
    expect(tally('alice', 5)).toBe(toRegisterUnits(1));
    // The student earns nothing on the teacher's claim; the claim's own
    // lifecycle advanced to settle, like every schema.
    expect(tally('bob', 5)).toBe(0);
    expect(tally('dave', 5)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-teach'))).toBe(2);
    // NO $RES movement: no bounty fires on the classification dim — the
    // verifier's per-check +2 is dave's (the generic C_18 credit), and bob's
    // only balance is his own tied record's C_2 bounty, unchanged.
    expect(res('alice')).toBe(0);
    expect(res('bob')).toBe(toRegisterUnits(3));
    expect(res('dave')).toBe(toRegisterUnits(2));
  });

  it('G-5-E (scaled). alphaFor(5) seeded to 2: the SAME arc credits the filer match × 2', () => {
    state.setRegister('config:alpha:5', toRegisterUnits(2), 'custodian');
    claimArc();
    expect(verify(state, teachVerifyOp('dave', { taught: 'bob', recordId: 'c-work' }))).toBe(0);
    expect(tally('alice', 5)).toBe(toRegisterUnits(1 * 2));
    expect(state.getRegister(CONTRIB_NAMES.step('c-teach'))).toBe(2);
  });

  it('G-5-F. the settle step completes the arc like every schema; no money moves', () => {
    claimArc();
    expect(verify(state, teachVerifyOp('dave', { taught: 'bob', recordId: 'c-work' }))).toBe(0);
    const aliceBefore = res('alice');
    const bobBefore = res('bob');
    expect(settle(state, makeOp('settle_contribution', 'alice', {
      contributionId: 'c-teach', submitter: 'alice', reason: 'the tie is real',
    } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-teach'))).toBe(1);
    expect(res('alice')).toBe(aliceBefore);
    expect(res('bob')).toBe(bobBefore);
    expect(tally('alice', 5)).toBe(toRegisterUnits(1));
  });
});
