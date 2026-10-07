import {
  DIMENSIONS, DIMENSION_COUNT, isValidDims, paymentFor, CALIBRATION_VERSION,
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
  schemaForDims, validateEvidenceRef, stepPaymentsFor,
} from '../../shared/src/contribution';
import { makeSettleContributionHandler, makeSubmitContributionHandler, makeVerifyContributionHandler } from '../../shared/src/handlers';
import { CONTRIB_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
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
  it('version is v1 and content limits are set', () => {
    expect(SCHEMA_VERSION).toBe('v1');
    expect(CONTENT_LIMITS.maxObjectBytes).toBe(8 * 1024 * 1024);
    expect(CONTENT_LIMITS.maxInlineEvidenceChars).toBe(2000);
  });

  it('wires C_1, C_2, C_18 as 3-step submit->verify->settle schemas', () => {
    for (const dim of [1, 2, 18]) {
      const schema = SCHEMAS.get(dim)!;
      expect(schema.dimIndex).toBe(dim);
      expect(schema.schemaVersion).toBe('v1');
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
    const verify = makeVerifyContributionHandler(node);
    expect(run(verify, state, makeOp('verify_contribution', 'bob',
      verifyOp({ contributionId: 'c-multi', dims: { '1': 1, '2': 0.5, '9': 1 }, reason: 'real artifact' })))).toBe(0);
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
    const verify = makeVerifyContributionHandler(node);
    run(verify, state, makeOp('verify_contribution', 'bob', verifyOp({ contributionId: 'c-expl', dims: { '1': 1 }, reason: 'solid' })));
    const explanations = state.allSetElements(CONTRIB_NAMES.explanations('c-expl'));
    expect(explanations).toHaveLength(2); // submit record + verify record
    const verifyRecord = JSON.parse(explanations.find((e) => e.includes('"verifier"'))!);
    expect(verifyRecord.stepId).toBe('verify');
    expect(verifyRecord.verification.verifier).toBe('bob');
    expect(verifyRecord.payments['alice']).toBe(RES_CONFIG.buildingBounty);
    expect(verifyRecord.calibrationVersion).toBe('v1');
    expect(verifyRecord.schemaVersion).toBe('v1');
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
