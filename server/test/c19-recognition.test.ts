// C_19 recognition (slice #6a) — the claim contracts. Recognition becomes
// submittable: the dim-19 schema is wired, and its payload carries the tie
// fields the machine validates through the submit/verify lifecycle.
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
import { CONTRIB_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
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

function verifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
  return makeOp('verify_contribution', signer, {
    contributionId: 'c-claim', submitter: 'alice', dims: { '19': 1 }, stepId: 'verify',
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
