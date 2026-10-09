import {
  DIMENSIONS, DIMENSION_COUNT, HARM_REDUCE_FACTOR, isValidDims, paymentFor, CALIBRATION_VERSION,
} from '../../shared/src/contribution';
import { RES_CONFIG } from '../../shared/src/policies';

describe('contribution registry', () => {
  it('defines exactly 22 dimensions indexed C_0..C_21', () => {
    expect(DIMENSIONS.length).toBe(22);
    expect(DIMENSION_COUNT).toBe(22);
    DIMENSIONS.forEach((d, i) => expect(d.index).toBe(i));
    expect(DIMENSIONS[1].code).toBe('C_1');
    expect(DIMENSIONS[1].name).toBe('Magician');
    expect(DIMENSIONS[18].name).toBe('Moon');
  });

  it('marks exactly C_1, C_2 and C_18 as implemented for payment', () => {
    const implemented = DIMENSIONS.filter((d) => d.implemented).map((d) => d.index);
    expect(implemented.sort((a, b) => a - b)).toEqual([1, 2, 18]);
  });

  describe('isValidDims', () => {
    it('accepts a sparse map of valid indices with weights in (0, 1]', () => {
      expect(isValidDims({ '1': 1, '2': 0.5 })).toBe(true);
      expect(isValidDims({ '18': 0.25 })).toBe(true);
    });
    it('rejects bad indices, weights, and shapes', () => {
      expect(isValidDims({})).toBe(false);
      expect(isValidDims({ '-1': 1 })).toBe(false);
      expect(isValidDims({ '22': 1 })).toBe(false);
      expect(isValidDims({ '1.5': 1 })).toBe(false);
      expect(isValidDims({ '1': 0 })).toBe(false);
      expect(isValidDims({ '1': 2 })).toBe(false);
      expect(isValidDims({ '01': 1 })).toBe(false);
      expect(isValidDims({ '1': Infinity })).toBe(false);
      expect(isValidDims({ '1': -0.5 })).toBe(false);
      expect(isValidDims([1, 2])).toBe(false);
      expect(isValidDims(null)).toBe(false);
    });
  });

  it('pays building and recording bounties scaled by match weight', () => {
    expect(paymentFor(1, 1)).toBe(RES_CONFIG.buildingBounty);
    expect(paymentFor(2, 0.5)).toBe(RES_CONFIG.recordingBaseCredit * 0.5);
  });
  it('pays nothing for dimensions without implemented rules', () => {
    expect(paymentFor(0, 1)).toBe(0);
    expect(paymentFor(18, 1)).toBe(0); // C_18 pays the verifier, not the submitter
    expect(paymentFor(7, 1)).toBe(0);
  });
  it('has a stable calibration version string', () => {
    expect(CALIBRATION_VERSION).toBe('v1');
  });
});

import {
  CONTENT_LIMITS, SCHEMA_VERSION, SCHEMAS, DEFAULT_SCHEMA,
  schemaForDims, schemaForRecord, validateEvidenceRef, stepPaymentsFor,
  STATUS_PENDING, STATUS_ACCEPTED, STATUS_REJECTED, STATUS_APPEALED,
  SCHEMA_VERSION_NUMBERS, KNOWN_SCHEMA_VERSIONS,
} from '../../shared/src/contribution';
import { makeSettleContributionHandler, makeSubmitContributionHandler, makeVerifyContributionHandler } from '../../shared/src/handlers';
import { RECIP_NAMES, CHECK_NAMES, CONTRIB_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
import { ContributionPayload, SettleContributionPayload, VerifyContributionPayload } from '../../shared/src/types';
import { HandlerOperation, HandlerState } from 'crabs-wasm';

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

// Local mock: getRegister returns number | undefined so tests can
// distinguish "never set" from an actual 0 (unlike handlers.test.ts's
// fallback-to-zero version).
class MockState {
  private sets = new Map<string, Set<string>>();
  private registers = new Map<string, number>();
  private pnCounters = new Map<string, number>();
  private node: MockNode;

  constructor(node: MockNode) {
    this.node = node;
  }

  incrementPNCounter(name: string, delta = 1): void {
    this.pnCounters.set(name, (this.pnCounters.get(name) || 0) + delta);
  }
  decrementPNCounter(name: string, delta = 1, _nodeId?: string): void {
    this.pnCounters.set(name, (this.pnCounters.get(name) || 0) - delta);
  }
  setRegister(name: string, value: number, _nodeId?: string): void {
    this.registers.set(name, value);
  }
  setAdd(name: string, element: string, _tag = element): void {
    this.ensureSet(name).add(element);
  }
  setRemove(name: string, element: string): void {
    this.ensureSet(name).delete(element);
  }
  getPNCounter(name: string): number {
    return this.pnCounters.get(name) || 0;
  }
  getRegister(name: string): number | undefined {
    return this.registers.get(name) ?? this.node.registers.get(name);
  }
  setContains(name: string, element: string): boolean {
    return this.sets.has(name) && this.sets.get(name)!.has(element);
  }
  allSetElements(name: string): string[] {
    return Array.from(this.sets.get(name) ?? []);
  }

  private ensureSet(name: string): Set<string> {
    let set = this.sets.get(name);
    if (!set) {
      set = new Set();
      this.sets.set(name, set);
    }
    return set;
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

// MockState.getRegister returns number | undefined, so it does not satisfy
// HandlerState structurally; the handler never observes that difference.
function run(
  handler: (state: HandlerState, op: HandlerOperation) => number,
  state: MockState,
  op: HandlerOperation
): number {
  return handler(state as unknown as HandlerState, op);
}

const GOOD_REF = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };

function setupMembers(state: MockState, ...usernames: string[]) {
  for (const u of usernames) state.setAdd(STATE_NAMES.members, u, u);
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

describe('submit_contribution handler (schema-driven)', () => {
  it('records the contribution and initializes the lifecycle at the verify step', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({})))).toBe(0);
    expect(state.setContains(STATE_NAMES.contributions, 'c-1')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1')) ?? -999).toBe(0);
    // lifecycle position: submit auto-completed ⇒ current step = index 1
    expect(state.getRegister(CONTRIB_NAMES.step('c-1'))).toBe(1);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-1', 'submit'))).toBe(1);
    // Round stamp: the submission belongs to the round current at submit time.
    expect(state.getRegister(CONTRIB_NAMES.contributionRound('c-1'))).toBe(1);
  });

  it('rejects a non-member submitter', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSubmitContributionHandler(node);
    expect(run(handler, state, makeOp('submit_contribution', 'mallory', submitOp({})))).toBe(-1);
    expect(state.setContains(STATE_NAMES.contributions, 'c-1')).toBe(false);
  });

  it('rejects duplicate contributionId, invalid dims, bad schemaVersion, bad evidenceRef', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({})))).toBe(0);
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({ summary: 'again' })))).toBe(-1);
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({ dims: {} })))).toBe(-1);
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({ schemaVersion: 'v0' })))).toBe(-1);
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({ evidenceRef: { ...GOOD_REF, hash: 'zz' } })))).toBe(-1);
  });

  it('rejects missing summary', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    const handler = makeSubmitContributionHandler(node);
    expect(run(handler, state, makeOp('submit_contribution', 'alice', submitOp({ summary: '' })))).toBe(-1);
  });
});

describe('step schemas', () => {
  it('version is v2 and content limits are set', () => {
    expect(SCHEMA_VERSION).toBe('v2');
    expect(CONTENT_LIMITS.maxObjectBytes).toBe(8 * 1024 * 1024);
    expect(CONTENT_LIMITS.maxInlineEvidenceChars).toBe(2000);
  });

  it('wires C_1, C_2, C_18 as 3-step submit->verify->settle schemas', () => {
    for (const dim of [1, 2, 18]) {
      const schema = SCHEMAS.get(dim)!;
      expect(schema.dimIndex).toBe(dim);
      expect(schema.schemaVersion).toBe('v2');
      expect(schema.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']);
      expect(schema.steps[0].op).toBe('submit_contribution');
      expect(schema.steps[1].op).toBe('verify_contribution');
      expect(schema.steps[2].op).toBe('settle_contribution');
      expect(schema.steps[1].actors).toContain('verifier');
      expect(schema.steps[1].antiGaming).toContain('no-self');
      expect(schema.steps[1].antiGaming).toContain('written-reason');
    }
  });

  it('defines a 2-step default schema for unwired dimensions', () => {
    expect(DEFAULT_SCHEMA.steps.map((s) => s.stepId)).toEqual(['submit', 'verify']);
    expect(schemaForDims({ '9': 1 }).dimIndex).toBe(-1);
    expect(schemaForDims({ '9': 1 })).toBe(DEFAULT_SCHEMA);
  });

  it('resolves the schema of the lowest wired dimIndex (deterministic priority)', () => {
    expect(schemaForDims({ '1': 0.5, '2': 1 }).dimIndex).toBe(1);
    expect(schemaForDims({ '18': 1, '2': 1 }).dimIndex).toBe(2);
    expect(schemaForDims({ '18': 1 }).dimIndex).toBe(18);
  });

  it('verify steps pay the actor per check and the submitter per dims', () => {
    const step = SCHEMAS.get(1)!.steps[1];
    const pays = stepPaymentsFor(step, { '1': 1, '2': 0.5 },
      { actor: 'bob', submitter: 'alice' });
    expect(pays.get('bob')).toBe(RES_CONFIG.verificationCheckCredit);
    expect(pays.get('alice')).toBe(RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5);
  });

  describe('validateEvidenceRef', () => {
    const good = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };
    it('accepts well-formed refs', () => expect(validateEvidenceRef(good)).toBe(true));
    it('rejects malformed refs', () => {
      expect(validateEvidenceRef({ ...good, hash: 'zz' })).toBe(false);
      expect(validateEvidenceRef({ ...good, uri: '' })).toBe(false);
      expect(validateEvidenceRef({ ...good, mediaType: '' })).toBe(false);
      expect(validateEvidenceRef({ ...good, size: -1 })).toBe(false);
      expect(validateEvidenceRef({ ...good, hash: 'zz'.repeat(32) })).toBe(false);
      expect(validateEvidenceRef(null)).toBe(false);
    });
  });
});

describe('schema v2 (two-verifier C_1) and legacy resolution', () => {
  it('exposes status constants (status register values)', () => {
    expect(STATUS_PENDING).toBe(0);
    expect(STATUS_ACCEPTED).toBe(1);
    expect(STATUS_REJECTED).toBe(2);
    expect(STATUS_APPEALED).toBe(3);
  });

  it('v2 default: C_1 requires all-parties count 2; C_2/C_18 stay single', () => {
    for (const dim of [2, 18]) {
      expect(SCHEMAS.get(dim)!.steps[1].requirement).toEqual({ mode: 'single', count: 1 });
    }
    const c1 = SCHEMAS.get(1)!.steps[1];
    expect(c1.requirement).toEqual({ mode: 'all-parties', count: 2 });
  });

  it('schemaForRecord v2 vs v1: two-verifier C_1 only in v2; legacy resolves single-verify', () => {
    const v2c1 = schemaForRecord('v2', { '1': 1 });
    expect(v2c1.steps[1].requirement).toEqual({ mode: 'all-parties', count: 2 });
    const v1c1 = schemaForRecord('v1', { '1': 1 });
    expect(v1c1.steps[1].requirement).toEqual({ mode: 'single', count: 1 });
    expect(v1c1.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']); // legacy 3-step
    expect(schemaForRecord('v1', { '9': 1 }).schemaVersion).toBe('v1'); // legacy default: 2-step, dimIndex -1
    expect(() => schemaForRecord('v9', { '1': 1 })).toThrow(); // unknown version → callers reject
  });

  it('known-schema-version map covers v1 and v2 only', () => {
    expect([...SCHEMA_VERSION_NUMBERS.keys()].sort()).toEqual(['v1', 'v2']);
    expect(SCHEMA_VERSION).toBe('v2');
    expect(KNOWN_SCHEMA_VERSIONS('v1')).toBe(true);
    expect(KNOWN_SCHEMA_VERSIONS('v2')).toBe(true);
    expect(KNOWN_SCHEMA_VERSIONS('v0')).toBe(false);
  });
});

function setupSubmitted(
  state: MockState,
  node: MockNode,
  signer = 'alice',
  contributionId = 'c-1',
  dims: Record<string, number> = { '2': 1 }
) {
  setupMembers(state, signer, 'bob');
  const handler = makeSubmitContributionHandler(node);
  run(handler, state, makeOp('submit_contribution', signer, submitOp({ contributionId, dims })));
  state.setRegister(RES_NAMES.balance(signer), 0);
  state.setRegister(RES_NAMES.balance('bob'), 0);
}

function verifyOp(payload: Partial<VerifyContributionPayload>, signer = 'bob'): VerifyContributionPayload {
  return {
    contributionId: 'c-1', submitter: 'alice', dims: { '2': 1 }, stepId: 'verify',
    pass: true, reason: 'checks out',
    ...payload,
  } as VerifyContributionPayload;
}

describe('verify_contribution handler (schema-driven)', () => {
  it('pays the verifier per completed check regardless of direction, rejects on reject', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node);
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ pass: false, reason: 'no record link' })))).toBe(0);
    expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit);
    expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(2);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-1', 'verify'))).toBe(1);
  });

  it('on pass at the final requirement: pays submitter per-dims, updates tallies, advances to settle', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-multi', { '1': 1, '2': 0.5, '9': 1 });
    setupMembers(state, 'carol'); // v2: C_1 needs a second distinct verifier
    const verify = makeVerifyContributionHandler(node);
    // First completed check (bob): requirement (all-parties, 2) not yet final —
    // no submitter payout, lifecycle does not advance.
    expect(run(verify, state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-multi', dims: { '1': 1, '2': 0.5, '9': 1 }, reason: 'real artifact' })))).toBe(0);
    expect(state.getRegister(RES_NAMES.balance('alice')) ?? 0).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-multi'))).toBe(1);
    // Second completed check (carol): final requirement completes — payout,
    // tallies, and step advance fire exactly once, here.
    expect(run(verify, state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-multi', dims: { '1': 1, '2': 0.5, '9': 1 }, reason: 'also real' })))).toBe(0);
    const expected = RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5;
    expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(expected);
    expect(state.getRegister('dim:alice:c1')).toBe(1);
    expect(state.getRegister('dim:alice:c2')).toBe(0.5);
    expect(state.getRegister('dim:alice:c9')).toBeUndefined(); // classification-only: never registered
    expect(state.getRegister(CONTRIB_NAMES.step('c-multi'))).toBe(2); // advanced to settle
    expect(state.getRegister(CONTRIB_NAMES.status('c-multi'))).toBe(0);
    expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit);
  });

  it('default schema: pass at the terminal verify step finalizes as accepted', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-term', { '9': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-term', dims: { '9': 1 } })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-term'))).toBe(1);
    expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(0);
    expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit);
  });

  it('rejects self-verification', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-self');
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'alice',
      verifyOp({ contributionId: 'c-self', submitter: 'alice' })))).toBe(-1);
  });

  it('rejects a second verification after the terminal step finalized', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-twice', { '9': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-twice', dims: { '9': 1 } })))).toBe(0);
    const bobBalance = state.getRegister(RES_NAMES.balance('bob'));
    expect(run(verify, state, makeOp('verify_contribution', 'carol', verifyOp({ contributionId: 'c-twice', dims: { '9': 1 } })))).toBe(-1);
    expect(run(verify, state, makeOp('verify_contribution', 'carol', verifyOp({ contributionId: 'c-twice', dims: { '9': 1 }, pass: false })))).toBe(-1);
    expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(bobBalance);
  });

  it('rejects wrong stepId, unknown contribution, unknown submitter, invalid dims', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-guards');
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ stepId: 'settle' })))).toBe(-1);
    expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'ghost' })))).toBe(-1);
    expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ submitter: 'ghost-user' })))).toBe(-1);
    expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ dims: { '22': 1 } })))).toBe(-1);
  });

  it('explanation record captures verifier, payments and versions', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-expl', { '1': 1 });
    setupMembers(state, 'carol'); // v2: C_1 needs a second distinct verifier
    const verify = makeVerifyContributionHandler(node);
    run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-expl', dims: { '1': 1 }, reason: 'solid' })));
    run(verify, state, makeOp('verify_contribution', 'carol', verifyOp({ contributionId: 'c-expl', dims: { '1': 1 }, reason: 'solid too' })));
    const explanations = state.allSetElements(CONTRIB_NAMES.explanations('c-expl'));
    expect(explanations).toHaveLength(3); // submit record + 2 verify records
    const verifyRecords = explanations.filter((e) => e.includes('"verifier"')).map((e) => JSON.parse(e));
    expect(verifyRecords).toHaveLength(2);
    // The final verifier's record carries the one-time submission payout.
    const finalRecord = verifyRecords.find((r) => r.payments['alice'] !== undefined);
    expect(finalRecord.verification.verifier).toBe('carol');
    expect(finalRecord.stepId).toBe('verify');
    expect(finalRecord.payments['alice']).toBe(RES_CONFIG.buildingBounty);
    expect(finalRecord.calibrationVersion).toBe('v1');
    expect(finalRecord.schemaVersion).toBe('v2');
  });

  describe('verify reciprocity and accuracy (phase 3)', () => {
    it('blocks the per-pair repeat: bob cannot verify the same submitter twice, and a barred verifier is paid nothing', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-recip1', { '2': 1 });
      const verify = makeVerifyContributionHandler(node);
      // C_2 single verify: bob completes it once.
      expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-recip1' })))).toBe(0);
      const bobBalanceAfterFirst = state.getRegister(RES_NAMES.balance('bob'));
      expect(bobBalanceAfterFirst).toBe(RES_CONFIG.verificationCheckCredit);
      // A new contribution from alice: bob is blocked by the reciprocity set —
      // -1 fires BEFORE the per-check credit. (setupSubmitted resets the demo
      // balance registers, so compare against the fresh baseline.)
      setupSubmitted(state, node, 'alice', 'c-recip2', { '2': 1 });
      const bobBalanceBeforeBlocked = state.getRegister(RES_NAMES.balance('bob'));
      expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-recip2' })))).toBe(-1);
      expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(bobBalanceBeforeBlocked); // unchanged: no credit
      expect(state.getRegister(CHECK_NAMES.total('bob'))).toBe(1); // blocked check not counted
      expect(state.setContains(RECIP_NAMES.verifiedBy('alice'), 'bob')).toBe(true); // pin the guard set
    });

    it('blocks the mutual loop: a member cannot verify back a submitter who previously verified them', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-loop1', { '2': 1 });
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-loop1' })))).toBe(0);
      // bob's contribution, verified by alice — MUTUAL LOOP BAR: bob already
      // verified alice (recip:alice ⊇ bob), and a member may verify a
      // submitter only if that submitter never verified them.
      setupSubmitted(state, node, 'bob', 'c-loop2', { '2': 1 });
      expect(run(verify, state, makeOp('verify_contribution', 'alice',
        verifyOp({ contributionId: 'c-loop2', submitter: 'bob' })))).toBe(-1);
      expect(state.setContains(RECIP_NAMES.verifiedBy('alice'), 'bob')).toBe(true); // barred pair recorded
      // bob's repeat attempt on alice is barred too (per-pair once).
      setupSubmitted(state, node, 'alice', 'c-loop3', { '2': 1 });
      expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-loop3' })))).toBe(-1);
    });

    it('a signer listed in priorVerifiers is rejected (all-parties distinct actors); unlisted verifiers pass', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-pv1', { '2': 1 });
      setupMembers(state, 'carol');
      const verify = makeVerifyContributionHandler(node);
      // Client attests bob already verified this completion → refusal for bob.
      expect(run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-pv1', priorVerifiers: ['bob'] })))).toBe(-1);
      expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(0); // no credit on refusal
      // carol is NOT listed → verification proceeds.
      expect(run(verify, state, makeOp('verify_contribution', 'carol', verifyOp({ contributionId: 'c-pv1', priorVerifiers: ['bob'] })))).toBe(0);
      expect(state.getRegister(CONTRIB_NAMES.step('c-pv1'))).toBe(2); // single C_2 verify completed
    });

    it('accuracy: per-verifier total increments once per completed check (two-verifier C_1)', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-acc', { '1': 1 });
      setupMembers(state, 'carol');
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob',
        verifyOp({ contributionId: 'c-acc', dims: { '1': 1 }, reason: 'real artifact' })))).toBe(0);
      expect(run(verify, state, makeOp('verify_contribution', 'carol',
        verifyOp({ contributionId: 'c-acc', dims: { '1': 1 }, reason: 'real too' })))).toBe(0);
      expect(state.getRegister(CHECK_NAMES.total('bob'))).toBe(1);
      expect(state.getRegister(CHECK_NAMES.total('carol'))).toBe(1);
    });

    it('accuracy: rejected checks also count toward the verifier total', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-acc-rej', { '2': 1 });
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob',
        verifyOp({ contributionId: 'c-acc-rej', pass: false, reason: 'no record link' })))).toBe(0);
      expect(state.getRegister(CHECK_NAMES.total('bob'))).toBe(1);
    });
  });

  describe('verify harm adjustments', () => {
    it('reduced halves the bounty and the tally deltas', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-harm1', { '1': 1, '2': 0.5 });
      setupMembers(state, 'carol'); // v2: C_1 needs a second distinct verifier
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob',
        verifyOp({ contributionId: 'c-harm1', dims: { '1': 1, '2': 0.5 }, harm: 'reduced' })))).toBe(0);
      expect(run(verify, state, makeOp('verify_contribution', 'carol',
        verifyOp({ contributionId: 'c-harm1', dims: { '1': 1, '2': 0.5 }, priorHarm: 'reduced' })))).toBe(0);
      const expected = (RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5) * HARM_REDUCE_FACTOR;
      expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(expected);
      expect(state.getRegister('dim:alice:c1')).toBe(0.5);      // delta × 0.5
      expect(state.getRegister('dim:alice:c2')).toBe(0.25);     // 0.5 × 0.5
      expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit); // verifier credit NOT adjusted
      const records = state.allSetElements(CONTRIB_NAMES.explanations('c-harm1'));
      const finalRecord = JSON.parse(records.find((e: string) => e.includes('"payments"') && !e.includes('"payments":{}')) ?? '{}');
      expect(finalRecord.harm).toBe('reduced');
    });

    it('voided zeroes payment and tally; status still accepted', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-harm2', { '2': 1 });
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob',
        verifyOp({ contributionId: 'c-harm2', harm: 'voided' })))).toBe(0);
      expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(0);
      expect(state.getRegister('dim:alice:c2')).toBeUndefined(); // no tally register created for a voided delta
      // C_2's verify step is not terminal (v2: submit→verify→settle) — the
      // lifecycle advances to settle; settlement then finalizes as accepted.
      expect(state.getRegister(CONTRIB_NAMES.step('c-harm2'))).toBe(2);
      expect(run(makeSettleContributionHandler(node), state, makeOp('settle_contribution', 'alice',
        settleOp({ contributionId: 'c-harm2' })))).toBe(0);
      expect(state.getRegister(CONTRIB_NAMES.status('c-harm2'))).toBe(1);
      expect(state.getRegister(RES_NAMES.balance('bob'))).toBe(RES_CONFIG.verificationCheckCredit);
    });

    it('invalid harm strings are rejected outright', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-harm3', { '2': 1 });
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob',
        verifyOp({ contributionId: 'c-harm3', harm: 'kind-of' as never })))).toBe(-1);
      expect(state.getRegister(CONTRIB_NAMES.status('c-harm3'))).toBe(0); // untouched
    });

    it('strongest-wins across checks: priorHarm voided beats the current reduced', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupSubmitted(state, node, 'alice', 'c-harm4', { '1': 1 });
      setupMembers(state, 'carol');
      const verify = makeVerifyContributionHandler(node);
      expect(run(verify, state, makeOp('verify_contribution', 'bob',
        verifyOp({ contributionId: 'c-harm4', dims: { '1': 1 }, harm: 'reduced' })))).toBe(0);
      expect(run(verify, state, makeOp('verify_contribution', 'carol',
        verifyOp({ contributionId: 'c-harm4', dims: { '1': 1 }, harm: 'reduced', priorHarm: 'voided' })))).toBe(0);
      expect(state.getRegister(RES_NAMES.balance('alice'))).toBe(0);
      expect(state.getRegister('dim:alice:c1')).toBeUndefined();
      expect(state.getRegister(CONTRIB_NAMES.step('c-harm4'))).toBe(2); // still accepted lifecycle
      // Voided ⇒ empty payments map, so locate the completing verifier's record directly.
      const records = state.allSetElements(CONTRIB_NAMES.explanations('c-harm4'));
      const finalRecord = records.map((e: string) => JSON.parse(e))
        .find((r: { verification?: { verifier?: string } }) => r.verification?.verifier === 'carol');
      expect(finalRecord.harm).toBe('voided');
    });
  });
});

function settleOp(payload: Partial<SettleContributionPayload>, signer = 'alice'): SettleContributionPayload {
  return {
    contributionId: 'c-1', submitter: 'alice', reason: 'recorded my outcome',
    ...payload,
  } as SettleContributionPayload;
}

describe('settle_contribution handler', () => {
  function setupAtSettle(node: MockNode, state: MockState, contributeId: string) {
    setupSubmitted(state, node, 'alice', contributeId);
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: contributeId, pass: true, reason: 'ok' })))).toBe(0);
  }

  it('the submitter settles after verification, finalizing as accepted', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupAtSettle(node, state, 'c-settle');
    const settle = makeSettleContributionHandler(node);
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      settleOp({ contributionId: 'c-settle' })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-settle'))).toBe(1);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-settle', 'settle'))).toBe(1);
    const explanations = state.allSetElements(CONTRIB_NAMES.explanations('c-settle'));
    const settleRecord = JSON.parse(explanations.find((e) => e.includes('"settlement"'))!);
    expect(settleRecord.stepId).toBe('settle');
    expect(settleRecord.settlement.settler).toBe('alice');
    expect(settleRecord.calibrationVersion).toBe('v1');
  });

  it('rejects settlement by a non-submitter, at the wrong step, or twice', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupAtSettle(node, state, 'c-guard');
    const settle = makeSettleContributionHandler(node);
    expect(run(settle, state, makeOp('settle_contribution', 'bob',
      settleOp({ contributionId: 'c-guard', submitter: 'alice', reason: 'not mine' })))).toBe(-1);
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      settleOp({ contributionId: 'c-guard', reason: 'ok' })))).toBe(0);
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      settleOp({ contributionId: 'c-guard', reason: 'again' })))).toBe(-1);
  });

  it('rejects settle at the verify step and for the default-schema lifecycle', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-nosettle', { '9': 1 });
    const settle = makeSettleContributionHandler(node);
    // default schema: terminal is verify (index 1) ⇒ settle invalid at index 1
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      settleOp({ contributionId: 'c-nosettle', reason: 'early' })))).toBe(-1);
  });

  it('rejects settle without a written reason', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupAtSettle(node, state, 'c-reason');
    const settle = makeSettleContributionHandler(node);
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      settleOp({ contributionId: 'c-reason', reason: '' })))).toBe(-1);
  });

  describe('settle upheld-accuracy increments (phase 3)', () => {
    it('the settle lists verifiers; each upheld register increments once per listed verifier and upheld == total', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupAtSettle(node, state, 'c-up1');
      const settle = makeSettleContributionHandler(node);
      expect(run(settle, state, makeOp('settle_contribution', 'alice', {
        contributionId: 'c-up1', submitter: 'alice', reason: 'done', verifiers: ['bob', 'bob'],
      } as SettleContributionPayload))).toBe(0);
      expect(state.getRegister(CHECK_NAMES.upheld('bob'))).toBe(1); // deduped: listed twice, +1 once
      expect(state.getRegister(CHECK_NAMES.total('bob'))).toBe(1); // upheld == total
      expect(state.getRegister(CHECK_NAMES.upheld('ghost'))).toBeUndefined(); // unlisted verifier untouched
    });

    it('settle rejects non-member verifiers; empty verifiers list is a clean no-op settle', () => {
      const node = new MockNode();
      const state = new MockState(node);
      setupAtSettle(node, state, 'c-up2');
      const settle = makeSettleContributionHandler(node);
      expect(run(settle, state, makeOp('settle_contribution', 'alice', {
        contributionId: 'c-up2', submitter: 'alice', reason: 'x', verifiers: ['not-a-member'],
      } as SettleContributionPayload))).toBe(-1);
      expect(state.getRegister(CONTRIB_NAMES.status('c-up2'))).toBe(0); // rejected before any write
      expect(state.getRegister(CHECK_NAMES.upheld('not-a-member'))).toBeUndefined();
      // PoC: the client-attested list is optional — an empty (or absent) list
      // settles with nothing tracked.
      expect(run(settle, state, makeOp('settle_contribution', 'alice', {
        contributionId: 'c-up2', submitter: 'alice', reason: 'x', verifiers: [],
      } as SettleContributionPayload))).toBe(0);
      expect(state.getRegister(CONTRIB_NAMES.status('c-up2'))).toBe(1);
    });
  });
});

import {
  makeSetCalibrationVersionHandler, makeSetRctAlphaHandler,
} from '../../shared/src/handlers';
import { CALIBRATIONS } from '../../shared/src/policies';
import { SetCalibrationVersionPayload, SetRctAlphaPayload } from '../../shared/src/types';

describe('calibration ops', () => {
  it('set_rct_alpha writes sparse weights and bumps alpha version', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSetRctAlphaHandler(node);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', {
      weights: { '1': 2, '2': 0.5 }, version: 'alpha-2',
    } as SetRctAlphaPayload))).toBe(0);
    expect(state.getRegister(CALIBRATIONS.alpha(1))).toBe(2);
    expect(state.getRegister(CALIBRATIONS.alpha(2))).toBe(0.5);
    expect(state.getRegister(CALIBRATIONS.alphaVersion())).toBe(1); // first write bumps 0 -> 1
  });

  it('set_rct_alpha rejects invalid subsets and weights', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSetRctAlphaHandler(node);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '22': 1 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '-1': 1 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '01': 1 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '1.5': 1 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '1': 0 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '1': 11 }, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: [1, 2], version: 'x' } as unknown as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: {}, version: 'x' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '1': 2 }, version: '' } as SetRctAlphaPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '1': 2 }, version: 'y'.repeat(65) } as SetRctAlphaPayload))).toBe(-1);
  });

  it('set_rct_alpha appends an explanation record and bumps per call', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSetRctAlphaHandler(node);
    run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '3': 1.5 }, version: 'alpha-1' } as SetRctAlphaPayload));
    run(handler, state, makeOp('set_rct_alpha', 'cust1', { weights: { '4': 0.25 }, version: 'alpha-2' } as SetRctAlphaPayload));
    expect(state.getRegister(CALIBRATIONS.alphaVersion())).toBe(2);
    const records = state.allSetElements(CALIBRATIONS.explanations()).map((e) => JSON.parse(e));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ alphaVersion: 1, version: 'alpha-1', weights: { '3': 1.5 } });
    expect(records[1]).toEqual({ alphaVersion: 2, version: 'alpha-2', weights: { '4': 0.25 } });
  });

  it('set_calibration_version maps known version to its index', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeSetCalibrationVersionHandler(node);
    expect(run(handler, state, makeOp('set_calibration_version', 'cust1', { version: 'v1' } as SetCalibrationVersionPayload))).toBe(0);
    expect(state.getRegister(CALIBRATIONS.calibrationVersion())).toBe(1);
    expect(run(handler, state, makeOp('set_calibration_version', 'cust1', { version: 'v99' } as SetCalibrationVersionPayload))).toBe(-1);
    expect(run(handler, state, makeOp('set_calibration_version', 'cust1', {} as unknown as SetCalibrationVersionPayload))).toBe(-1);
  });
});

import {
  makeAuditRoundHandler, makeReckonRoundHandler,
} from '../../shared/src/handlers';
import { ROUND_NAMES } from '../../shared/src/policies';
import { AuditRoundPayload, ReckonRoundPayload } from '../../shared/src/types';

// Declares the round registers via MockNode (wiring state): a round register
// that already exists keeps its initial value on re-declare (real wasm:
// duplicate_operation without reset — pinned in crabs.test.ts).
function setupRound(node: MockNode, state: MockState, round = 1) {
  try { node.addRegister(ROUND_NAMES.current(), round); } catch { /* in tests the handler creates it */ }
  try { node.addRegister(ROUND_NAMES.stage(round), 0); } catch { /* ok */ }
}

describe('round spine: audit + reckon', () => {
  it('fair audit advances stage 0 -> 1 with an explanation record', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    // Pilot bootstrap: the calibration register is pre-set at 1 (wiring).
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring pre-sets */ }
    const audit = makeAuditRoundHandler(node);
    expect(run(audit, state, makeOp('audit_round', 'alice', { fair: true, note: 'all good', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(1);
    const records = state.allSetElements(ROUND_NAMES.explanations(1));
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]).fair).toBe(true);
  });

  it('unfair audit records the debt and completes the round WITHOUT aggregation', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
    const audit = makeAuditRoundHandler(node);
    expect(run(audit, state, makeOp('audit_round', 'alice', { fair: false, note: 'under-measured care work', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(3); // debt path: round completes with no publish
    expect(state.getRegister(ROUND_NAMES.current())).toBe(2); // next round begins
  });

  it('rejects audit with missing note, wrong calibration, or non-open stage', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    setupRound(node, state, 1);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
    const audit = makeAuditRoundHandler(node);
    expect(run(audit, state, makeOp('audit_round', 'alice', { fair: true, note: '', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(-1);
    expect(run(audit, state, makeOp('audit_round', 'alice', { fair: true, note: 'x', calibrationVersion: 'v9' } as AuditRoundPayload))).toBe(-1);
    expect(run(audit, state, makeOp('audit_round', 'nonmember', { fair: true, note: 'x', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(-1);
  });

  it('reckon requires the audited stage and a set calibration register', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    setupRound(node, state, 1);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
    const audit = makeAuditRoundHandler(node);
    const reckon = makeReckonRoundHandler(node);
    // Not audited yet:
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'early' } as ReckonRoundPayload))).toBe(-1);
    expect(run(audit, state, makeOp('audit_round', 'alice', { fair: true, note: 'ok', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'records are settled' } as ReckonRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(2);
    expect(state.allSetElements(ROUND_NAMES.explanations(1))).toHaveLength(2);
  });

  it('reckon is rejected without a calibration register (Justice gate)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'alice');
    setupRound(node, state, 1);
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring pre-sets; remove this line to see the gate */ }
    const audit = makeAuditRoundHandler(node);
    const reckon = makeReckonRoundHandler(node);
    expect(run(audit, state, makeOp('audit_round', 'alice', { fair: true, note: 'ok', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
    // Simulate unset calibration by direct register write (MockState):
    state.setRegister(CALIBRATIONS.calibrationVersion(), 0);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'x' } as ReckonRoundPayload))).toBe(-1);
  });
});

import { makeCompleteRoundHandler } from '../../shared/src/handlers';
import { CompleteRoundPayload } from '../../shared/src/types';
import { RCT_NAMES } from '../../shared/src/policies';

// Drives the full spine: r1-a submitted by alice, verified by bob AND carol
// (v2 two-verifier C_1 review), settled, then audit -> reckon leaves round 1
// at STAGE_RECKONED ready for publish.
function setupSpineReady(node: MockNode, state: MockState) {
  setupMembers(state, 'alice', 'bob', 'carol', 'closer', 'closer2');
  setupSubmitted(state, node, 'alice', 'r1-a', { '1': 1 });
  const verify = makeVerifyContributionHandler(node);
  expect(run(verify, state, makeOp('verify_contribution', 'bob',
    verifyOp({ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 }, pass: true, reason: 'ok' })))).toBe(0);
  expect(run(verify, state, makeOp('verify_contribution', 'carol',
    verifyOp({ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 }, pass: true, reason: 'ok too' })))).toBe(0);
  // settle alice's contribution to exit the 3-step schema cleanly
  const settle = makeSettleContributionHandler(node);
  expect(run(settle, state, makeOp('settle_contribution', 'alice',
    { contributionId: 'r1-a', submitter: 'alice', reason: 'done' } as SettleContributionPayload))).toBe(0);

  try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
  const audit = makeAuditRoundHandler(node, { getTimeMs: () => 0 });
  const reckon = makeReckonRoundHandler(node, { getTimeMs: () => 0 });
  expect(run(audit, state, makeOp('audit_round', 'closer2', { fair: true, note: 'ok', calibrationVersion: 'v1' } as AuditRoundPayload))).toBe(0);
  expect(run(reckon, state, makeOp('reckon_round', 'closer2', { note: 'settled' } as ReckonRoundPayload))).toBe(0);
}

describe('complete_round', () => {
  it('publishes cumulative RCT totals and advances the round', () => {
    const node = new MockNode();
    const state = new MockState(node);
    try { node.addRegister(CALIBRATIONS.alpha(1), 2); } catch { /* wiring */ }
    setupSpineReady(node, state);

    const complete = makeCompleteRoundHandler(node);
    expect(run(complete, state, makeOp('complete_round', 'closer2', {
      entries: [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(0);
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(3);
    expect(state.getRegister(ROUND_NAMES.current())).toBe(2);
    expect(state.getRegister(RCT_NAMES.balance('alice'))).toBe(2 * 1); // alpha(1)=2 × match 1
    const records = state.allSetElements(ROUND_NAMES.explanations(1));
    const publishRecord = JSON.parse(records.find((e) => e.includes('"stepId":"complete"')) ?? '{}');
    expect(publishRecord.stepId).toBe('complete');
    expect(publishRecord.entryCount).toBe(1);
    expect(publishRecord.totals['alice']).toBe(2);
    expect(publishRecord.alphaVersion).toBeDefined();
  });

  it('rejects entries that are unknown, duplicated, or not part of the round', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state);
    const complete = makeCompleteRoundHandler(node);
    expect(run(complete, state, makeOp('complete_round', 'closer2', {
      entries: [{ contributionId: 'ghost', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(-1);
    expect(run(complete, state, makeOp('complete_round', 'closer2', {
      entries: [
        { contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } },
        { contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } },
      ],
    } as CompleteRoundPayload))).toBe(-1);
    // Round-stamp validation: a REAL contribution from a different round is
    // not part of round 1.
    const node2 = new MockNode();
    const state2 = new MockState(node2);
    setupSpineReady(node2, state2);
    state2.setRegister(ROUND_NAMES.current(), 2); // publish round 1 → now in round 2
    state2.setAdd(STATE_NAMES.contributions, 'r2-x', 'r2-x');
    state2.setRegister(CONTRIB_NAMES.contributionRound('r2-x'), 2);
    state2.setRegister(CONTRIB_NAMES.status('r2-x'), 1);
    // Round-stamp validation: r1-a is real+accepted but belongs to round 1;
    // once the current round has advanced to 2 (simulated here), it is not
    // part of the round being completed.
    state.setRegister(ROUND_NAMES.current(), 2);
    state.setRegister(ROUND_NAMES.stage(2), 2); // STAGE_RECKONED
    expect(run(complete, state, makeOp('complete_round', 'closer2', {
      entries: [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(-1);
  });

  it('rejects before stage 2 and after completion (stage must be RECKONED)', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupMembers(state, 'closer');
    const complete = makeCompleteRoundHandler(node);
    expect(run(complete, state, makeOp('complete_round', 'closer', {
      entries: [],
    } as CompleteRoundPayload))).toBe(-1); // stage 0, and also empty entries
  });

  it('rejects empty entries list', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSpineReady(node, state);
    const complete = makeCompleteRoundHandler(node);
    expect(run(complete, state, makeOp('complete_round', 'closer2', {
      entries: [],
    } as CompleteRoundPayload))).toBe(-1);
  });
});

import { makeAppealVerdictHandler } from '../../shared/src/handlers';
import { AppealVerdictPayload } from '../../shared/src/types';

// Rejected and still within its once-guard window: the exact precondition the
// appeal op consumes (status register 2, verify step position, appealed unset).
function rejectedAndAppealable(node: MockNode, state: MockState, id: string) {
  setupSubmitted(state, node, 'alice', id, { '2': 1 });
  const verify = makeVerifyContributionHandler(node);
  expect(run(verify, state, makeOp('verify_contribution', 'bob',
    verifyOp({ contributionId: id, pass: false, reason: 'insufficient' })))).toBe(0);
  expect(state.getRegister(CONTRIB_NAMES.status(id))).toBe(2);
}

describe('appeal_verdict', () => {
  it('the submitter appeals a rejected contribution: status 3, appealed set, verify step rewound', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app1');
    const appeal = makeAppealVerdictHandler(node, { getTimeMs: () => 5000 });
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app1', submitter: 'alice', reason: 'evidence was misread' } as AppealVerdictPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app1'))).toBe(STATUS_APPEALED);
    expect(state.getRegister(CONTRIB_NAMES.appealed('c-app1'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.step('c-app1'))).toBe(1); // rewind to the verify step
    const records = state.allSetElements(CONTRIB_NAMES.explanations('c-app1')).map((e) => JSON.parse(e));
    const appealRecord = records.find((r) => r.stepId === 'appeal');
    expect(appealRecord).toEqual({
      contributionId: 'c-app1', stepId: 'appeal', reason: 'evidence was misread', at: 5000,
    });
  });

  it('rejects non-submitter, pending, accepted, unknown, and double appeals', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app2');
    const appeal = makeAppealVerdictHandler(node);
    // The submitter alone may appeal.
    expect(run(appeal, state, makeOp('appeal_verdict', 'bob',
      { contributionId: 'c-app2', submitter: 'alice', reason: 'not mine' } as AppealVerdictPayload))).toBe(-1);
    // A pending contribution (never verified) is never appealable.
    setupSubmitted(state, node, 'carol2', 'c-app3', { '2': 1 });
    expect(run(appeal, state, makeOp('appeal_verdict', 'carol2',
      { contributionId: 'c-app3', submitter: 'carol2', reason: 'pending' } as AppealVerdictPayload))).toBe(-1);
    // An accepted contribution is final — appeal it and get -1.
    setupMembers(state, 'dave');
    setupSubmitted(state, node, 'carol2', 'c-app3b', { '9': 1 });
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'dave',
      verifyOp({ contributionId: 'c-app3b', submitter: 'carol2', dims: { '9': 1 } })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app3b'))).toBe(1);
    expect(run(appeal, state, makeOp('appeal_verdict', 'carol2',
      { contributionId: 'c-app3b', submitter: 'carol2', reason: 'accepted' } as AppealVerdictPayload))).toBe(-1);
    // Unknown contribution.
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-ghost', submitter: 'alice', reason: 'ghost' } as AppealVerdictPayload))).toBe(-1);
    // First appeal succeeds; the once-guard blocks the second.
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app2', submitter: 'alice', reason: 'first appeal' } as AppealVerdictPayload))).toBe(0);
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app2', submitter: 'alice', reason: 'again' } as AppealVerdictPayload))).toBe(-1);
  });

  it('an appealed contribution re-verifies; verify leaves the status at 3 until settle completes it', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app4');
    const appeal = makeAppealVerdictHandler(node);
    const verify = makeVerifyContributionHandler(node);
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app4', submitter: 'alice', reason: 'appealing' } as AppealVerdictPayload))).toBe(0);
    setupMembers(state, 'carol'); // bob is per-pair barred after his rejection check
    // C_2 is wired: a 3-step v2 schema. Carol's single verify completes the
    // verify step and ADVANCES to settle; the verify handler only finalizes
    // the status register at a terminal step, so the status stays
    // STATUS_APPEALED here — pinned deliberately.
    expect(run(verify, state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-app4', reason: 're-review ok' })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-app4'))).toBe(2); // advanced to settle
    expect(state.getRegister(CONTRIB_NAMES.status('c-app4'))).toBe(STATUS_APPEALED);
    // Settle's status gate accepts STATUS_APPEALED and finalizes acceptance.
    const settle = makeSettleContributionHandler(node);
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-app4', submitter: 'alice', reason: 'settled after appeal' } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app4'))).toBe(STATUS_ACCEPTED);
  });

  it('an appealed C_1 flows through the v2 all-parties path: re-review, settle completes', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupSubmitted(state, node, 'alice', 'c-app5', { '1': 1 });
    setupMembers(state, 'carol', 'dave');
    const verify = makeVerifyContributionHandler(node);
    // bob rejects (one completed check; the per-pair once guard now records him).
    expect(run(verify, state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-app5', dims: { '1': 1 }, pass: false, reason: 'no artifact' })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app5'))).toBe(STATUS_REJECTED);
    const appeal = makeAppealVerdictHandler(node);
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app5', submitter: 'alice', reason: 'artifact exists' } as AppealVerdictPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app5'))).toBe(STATUS_APPEALED);
    // bob is barred from re-verifying alice (per-pair once) — re-review needs
    // fresh verifiers, which keeps reciprocal gaming impossible.
    expect(run(verify, state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-app5', dims: { '1': 1 }, reason: 'changed my mind' })))).toBe(-1);
    // The appeal resets the verify step's done PNCounter: bob's pre-appeal
    // rejection no longer occupies a quorum slot.
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-app5', 'verify'))).toBe(0);
    // The all-parties (2) re-review needs the FULL fresh quorum: bob's
    // rejected check is erased by the counter reset, so ONE fresh verifier
    // (carol) reaches done=1 of 2 — the step does NOT advance yet.
    expect(run(verify, state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-app5', dims: { '1': 1 }, reason: 'real' })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-app5'))).toBe(1); // still verifying
    expect(state.getRegister(CONTRIB_NAMES.status('c-app5'))).toBe(STATUS_APPEALED);
    // A SECOND fresh verifier completes the fresh quorum: done=2 is final and
    // the step advances to settle with the status register at STATUS_APPEALED.
    expect(run(verify, state, makeOp('verify_contribution', 'dave',
      verifyOp({ contributionId: 'c-app5', dims: { '1': 1 }, reason: 'also real', priorVerifiers: ['bob', 'carol'] })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-app5'))).toBe(2);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app5'))).toBe(STATUS_APPEALED);
    // Past the verify step, further verifies are refused (wrong lifecycle
    // position, ahead of the reciprocity tiers) — carol cannot add a third
    // completion.
    expect(run(verify, state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-app5', dims: { '1': 1 }, reason: 'late' })))).toBe(-1);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app5'))).toBe(STATUS_APPEALED);
    // Settlement accepts the appealed status and finalizes acceptance.
    const settle = makeSettleContributionHandler(node);
    expect(run(settle, state, makeOp('settle_contribution', 'alice',
      { contributionId: 'c-app5', submitter: 'alice', reason: 'settled after appeal' } as SettleContributionPayload))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app5'))).toBe(STATUS_ACCEPTED);
    // The once-guard survives the whole cycle: no chained appeals.
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app5', submitter: 'alice', reason: 'one more' } as AppealVerdictPayload))).toBe(-1);
  });

  it('a re-rejected appeal keeps the once-guard and cannot be appealed again', () => {
    const node = new MockNode();
    const state = new MockState(node);
    rejectedAndAppealable(node, state, 'c-app6');
    const appeal = makeAppealVerdictHandler(node);
    const verify = makeVerifyContributionHandler(node);
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app6', submitter: 'alice', reason: 'appealing' } as AppealVerdictPayload))).toBe(0);
    setupMembers(state, 'carol');
    // The re-review re-rejects: status 2 with the appealed register still 1.
    expect(run(verify, state, makeOp('verify_contribution', 'carol',
      verifyOp({ contributionId: 'c-app6', pass: false, reason: 'still insufficient' })))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-app6'))).toBe(STATUS_REJECTED);
    expect(state.getRegister(CONTRIB_NAMES.appealed('c-app6'))).toBe(1);
    expect(run(appeal, state, makeOp('appeal_verdict', 'alice',
      { contributionId: 'c-app6', submitter: 'alice', reason: 'one more try' } as AppealVerdictPayload))).toBe(-1);
  });
});
