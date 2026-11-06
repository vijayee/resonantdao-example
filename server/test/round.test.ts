import {
  STAGE_OPEN, STAGE_AUDITED, STAGE_RECKONED, STAGE_PUBLISHED,
  encodeSalientMask, decodeSalientMask,
  roundRctTotals, derivedVoteBalance,
  CALIBRATION_VERSIONS, CALIBRATION_VERSION_NUMBERS,
  isValidRoundEntry, AGGREGATE_ENTRY_LIMIT,
} from '../../shared/src/round';
import { HARM_REDUCE_FACTOR, harmFactorFor, strongestHarm, type HarmVerdict } from '../../shared/src/contribution';

describe('round registry', () => {
  it('stage constants are 0..3', () => {
    expect(STAGE_OPEN).toBe(0);
    expect(STAGE_AUDITED).toBe(1);
    expect(STAGE_RECKONED).toBe(2);
    expect(STAGE_PUBLISHED).toBe(3);
  });

  describe('salient mask', () => {
    it('encodes/decodes a subset of dimensions 0..21', () => {
      const mask = encodeSalientMask([1, 18]);
      expect(mask).toBe((1 << 1) | (1 << 18));
      expect(decodeSalientMask(mask)).toEqual([1, 18]);
    });
    it('empty list encodes 0 (base-membership-only question)', () => {
      expect(encodeSalientMask([])).toBe(0);
      expect(decodeSalientMask(0)).toEqual([]);
    });
    it('rejects out-of-range and duplicate dims', () => {
      expect(() => encodeSalientMask([22])).toThrow();
      expect(() => encodeSalientMask([-1])).toThrow();
      expect(() => encodeSalientMask([1, 1])).toThrow();
      expect(() => encodeSalientMask([1.5] as unknown as number[])).toThrow();
    });
  });

  describe('roundRctTotals', () => {
    const alphaFor = (i: number) => (i === 1 ? 2 : 1);
    it('aggregates per submitter over entries; unscored dims contribute nothing', () => {
      const totals = roundRctTotals([
        { contributionId: 'a', submitter: 'alice', dims: { '1': 1, '9': 1 } },
        { contributionId: 'b', submitter: 'alice', dims: { '2': 0.5 } },
        { contributionId: 'c', submitter: 'bob', dims: { '2': 1 } },
      ], alphaFor);
      expect(totals.get('alice')).toBe(2 * 1 + 1 * 1 + 1 * 0.5); // 3.5 — dim 9 has no tally input by construction (caller filters); alpha defaulting is the caller's concern
      expect(totals.get('bob')).toBe(1);
    });
    it('returns an empty map for no entries', () => {
      expect(roundRctTotals([], alphaFor).size).toBe(0);
    });
    it('RCT-A: self-claimed entries (no recipient) attribute to the submitter — every standing number unchanged', () => {
      const totals = roundRctTotals([
        { contributionId: 'a', submitter: 'alice', dims: { '1': 1 } },
        { contributionId: 'b', submitter: 'bob', dims: { '2': 0.5 } },
      ], alphaFor);
      expect(totals.get('alice')).toBe(2);
      expect(totals.get('bob')).toBe(0.5);
    });
    it('RCT-B: an entry with recipient=X attributes X\'s total — the RECIPIENT of the work, not the filer', () => {
      // bob recognizes carol's proven work; carol carries the credit while
      // alice's self-claim stays hers (a mixed round pins BOTH shapes).
      const totals = roundRctTotals([
        { contributionId: 'a', submitter: 'alice', dims: { '1': 1 } },
        { contributionId: 'b', submitter: 'bob', recipient: 'carol', dims: { '19': 1 } },
      ], alphaFor);
      expect(totals.get('carol')).toBe(1);
      expect(totals.get('alice')).toBe(2 * 1);
      expect(totals.get('bob')).toBeUndefined(); // the filer of a recipient claim collects nothing
    });
  });

  describe('derivedVoteBalance', () => {
    const tally = (i: number) => (i === 1 ? 10 : i === 2 ? 0.5 : 0);
    const alpha = (i: number) => (i === 1 ? 2 : 1);
    it('base plus masked salient contributions', () => {
      expect(derivedVoteBalance(encodeSalientMask([1]), (i) => alpha(i), tally, 3, 50)).toBe(3 + 2 * 10);
      expect(derivedVoteBalance(encodeSalientMask([1, 2]), (i) => alpha(i), tally, 3, 50)).toBe(3 + 2 * 10 + 0.5);
      expect(derivedVoteBalance(0, (i) => alpha(i), tally, 3, 50)).toBe(3); // base-only (elections, no salience)
    });
    it('caps the derived balance', () => {
      expect(derivedVoteBalance(encodeSalientMask([1]), (i) => alpha(i), tally, 3, 10)).toBe(10);
    });
  });

  it('calibration versions map v1 <-> 1', () => {
    expect(CALIBRATION_VERSIONS).toEqual(['v1']);
    expect(CALIBRATION_VERSION_NUMBERS.get('v1')).toBe(1);
  });

  describe('isValidRoundEntry', () => {
    it('accepts well-formed entries and rejects broken ones', () => {
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'alice', dims: { '1': 1 } })).toBe(true);
      expect(isValidRoundEntry({ contributionId: '', submitter: 'alice', dims: { '1': 1 } })).toBe(false);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: '', dims: { '1': 1 } })).toBe(false);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: {} })).toBe(false);
      expect(isValidRoundEntry(null)).toBe(false);
      expect(AGGREGATE_ENTRY_LIMIT).toBe(200);
    });
    it('accepts recipient-carrying entries (additive optional field) and rejects a non-string recipient', () => {
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '19': 1 }, recipient: 'carol' })).toBe(true);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '19': 1 }, recipient: 7 })).toBe(false);
    });
  });
});

describe('harm adjustments (constants + helpers)', () => {
  it('reduced factor is the 0.5 pilot constant', () => {
    expect(HARM_REDUCE_FACTOR).toBe(0.5);
    expect(harmFactorFor(undefined)).toBe(1);
    expect(harmFactorFor('none')).toBe(1);
    expect(harmFactorFor('reduced')).toBe(0.5);
    expect(harmFactorFor('voided')).toBe(0);
    expect(() => harmFactorFor('kind-of' as unknown as HarmVerdict)).toThrow(); // invalid verdicts rejected at validation, never defaulted
  });

  it('strongest-wins: voided > reduced > none', () => {
    expect(strongestHarm(undefined, undefined)).toBe('none');
    expect(strongestHarm('reduced', undefined)).toBe('reduced');
    expect(strongestHarm(undefined, 'reduced')).toBe('reduced');
    expect(strongestHarm('reduced', 'voided')).toBe('voided');
    expect(strongestHarm('voided', 'reduced')).toBe('voided');
    expect(strongestHarm('none', 'none')).toBe('none');
  });
});

// Spine credits (slice #6c): the settlement spine's closing turns pay their
// designed contribution-token tallies — C_20 on reckon_round, C_21 on
// complete_round, weight-scaled per the general calibration rule (match = 1;
// spine ops carry no harm). These contracts are pinned against the handlers.
import {
  makeCompleteRoundHandler, makeReckonRoundHandler,
} from '../../shared/src/handlers';
import {
  CALIBRATIONS, CONTRIB_NAMES, RES_NAMES, RCT_NAMES, ROUND_NAMES, STATE_NAMES,
} from '../../shared/src/policies';
import { ReckonRoundPayload, CompleteRoundPayload } from '../../shared/src/types';
import { REG_SCALE } from '../../shared/src/contribution';
import { HandlerOperation, HandlerState } from 'crabs-wasm';

// The spine suite's harness mirrors contribution.test.ts's per-file mock (the
// house convention: each handler suite carries its own). getRegister preserves
// "unset" (number | undefined) so absence pins stay honest.
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

class MockState {
  private sets = new Map<string, Set<string>>();
  private registers = new Map<string, number>();
  private node: MockNode;

  constructor(node: MockNode) {
    this.node = node;
  }

  setRegister(name: string, value: number, _nodeId?: string): void {
    this.registers.set(name, value);
  }
  setAdd(name: string, element: string, _tag = element): void {
    this.ensureSet(name).add(element);
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
  return { type, signerId, nodeId: 'browser', payload: JSON.stringify(payload), resources: [] };
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

// Fractional-bearing registers store Math.round(value × 1000) — reads divide
// by REG_SCALE to compare in LOGICAL units, preserving "unset".
function logical(state: MockState, register: string): number | undefined {
  const value = state.getRegister(register);
  return value === undefined ? undefined : value / REG_SCALE;
}

function setupMembers(state: MockState, ...usernames: string[]) {
  for (const u of usernames) state.setAdd(STATE_NAMES.members, u, u);
}

// Reckonable round: members wired, calibration register set (the Justice gate)
// and round 1 parked at STAGE_AUDITED — the state a fair audit leaves behind.
function setupReckonable(node: MockNode, state: MockState, round = 1) {
  setupMembers(state, 'alice', 'bob');
  try { node.addRegister(ROUND_NAMES.current(), round); } catch { /* wiring */ }
  try { node.addRegister(ROUND_NAMES.stage(round), 0); } catch { /* ok */ }
  try { node.addRegister(CALIBRATIONS.calibrationVersion(), 1); } catch { /* wiring */ }
  state.setRegister(ROUND_NAMES.stage(round), STAGE_AUDITED);
}

// The accepted contribution the publish aggregate validates against (direct
// register writes — the lifecycle handlers' own arcs are pinned in
// contribution.test.ts; here only the aggregate's gates matter).
function setupAcceptedContribution(node: MockNode, state: MockState, round = 1, id = 'r1-a') {
  state.setAdd(STATE_NAMES.contributions, id, id);
  state.setRegister(CONTRIB_NAMES.contributionRound(id), round);
  state.setRegister(CONTRIB_NAMES.status(id), 1);
}

function setupPublishable(node: MockNode, state: MockState, round = 1) {
  setupReckonable(node, state, round);
  setupAcceptedContribution(node, state, round);
  state.setRegister(ROUND_NAMES.stage(round), STAGE_RECKONED);
}

describe('spine credits (C_20 on reckon, C_21 on complete)', () => {
  it('SP-A: reckon_round credits the signer\'s C_20 tally — alpha unset defaults to 1.000', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupReckonable(node, state);
    const reckon = makeReckonRoundHandler(node);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'records are settled' } as ReckonRoundPayload))).toBe(0);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('alice', 20))).toBe(1);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('bob', 20))).toBeUndefined(); // the signer only
    // The op's existing effects unchanged; no $RES/RCT movement.
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(STAGE_RECKONED);
    expect(state.allSetElements(ROUND_NAMES.explanations(1))).toHaveLength(1);
    expect(logical(state, RES_NAMES.balance('alice'))).toBeUndefined();
    expect(logical(state, RCT_NAMES.balance('alice'))).toBeUndefined();
  });

  it('SP-A seeded: alpha(20)=2 scales the C_20 tally to 2.000', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupReckonable(node, state);
    // Alpha weights store per-mille register units — seed the SCALED value.
    try { node.addRegister(CALIBRATIONS.alpha(20), 2 * REG_SCALE); } catch { /* wiring */ }
    const reckon = makeReckonRoundHandler(node);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'records are settled' } as ReckonRoundPayload))).toBe(0);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('alice', 20))).toBe(2);
  });

  it('SP-B: complete_round credits the signer\'s C_21 tally — alpha unset defaults to 1.000', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupPublishable(node, state);
    const complete = makeCompleteRoundHandler(node);
    expect(run(complete, state, makeOp('complete_round', 'alice', {
      entries: [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(0);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('alice', 21))).toBe(1);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('bob', 21))).toBeUndefined(); // the signer only
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('alice', 20))).toBeUndefined(); // each op pays its own dim
    // Everything standing intact: the RCT credit and the stage registers.
    expect(logical(state, RCT_NAMES.balance('alice'))).toBe(1); // alpha(1) unset → 1 × match 1
    expect(state.getRegister(ROUND_NAMES.stage(1))).toBe(STAGE_PUBLISHED);
    expect(state.getRegister(ROUND_NAMES.current())).toBe(2);
  });

  it('SP-B seeded: alpha(21)=2 scales the C_21 tally to 2.000', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupPublishable(node, state);
    try { node.addRegister(CALIBRATIONS.alpha(21), 2 * REG_SCALE); } catch { /* wiring */ }
    const complete = makeCompleteRoundHandler(node);
    expect(run(complete, state, makeOp('complete_round', 'alice', {
      entries: [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(0);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('alice', 21))).toBe(2);
  });

  it('SP-C: a SECOND legal drive (the appeal-rewound replay) accumulates — no dedupe guard', () => {
    // Reckon arc: after the first reckoning the appeal rewind returns the
    // stage to AUDITED; the tally register stands and the re-drive stacks.
    const node = new MockNode();
    const state = new MockState(node);
    setupReckonable(node, state);
    const reckon = makeReckonRoundHandler(node);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'settled' } as ReckonRoundPayload))).toBe(0);
    state.setRegister(ROUND_NAMES.stage(1), STAGE_AUDITED);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 're-settled' } as ReckonRoundPayload))).toBe(0);
    expect(logical(state, CONTRIB_NAMES.dimensionBalance('alice', 20))).toBe(2);

    // Complete arc: the rewind returns current + stage to a publishable state
    // (the published RCT register stands) and the re-drive stacks both.
    const node2 = new MockNode();
    const state2 = new MockState(node2);
    setupPublishable(node2, state2);
    const complete = makeCompleteRoundHandler(node2);
    const entry = [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }];
    expect(run(complete, state2, makeOp('complete_round', 'alice', { entries: entry } as CompleteRoundPayload))).toBe(0);
    state2.setRegister(ROUND_NAMES.current(), 1);
    state2.setRegister(ROUND_NAMES.stage(1), STAGE_RECKONED);
    expect(run(complete, state2, makeOp('complete_round', 'alice', { entries: entry } as CompleteRoundPayload))).toBe(0);
    expect(logical(state2, CONTRIB_NAMES.dimensionBalance('alice', 21))).toBe(2);
    expect(logical(state2, RCT_NAMES.balance('alice'))).toBe(2); // the registers' accumulation behavior, matched
  });

  it('SP-D: neither op moves a single res: register — the balances stand', () => {
    const node = new MockNode();
    const state = new MockState(node);
    setupReckonable(node, state);
    setupAcceptedContribution(node, state);
    try { node.addRegister(RES_NAMES.balance('alice'), 3.5 * REG_SCALE); } catch { /* wiring */ }
    const beforeAlice = logical(state, RES_NAMES.balance('alice'));
    const beforeBob = logical(state, RES_NAMES.balance('bob'));
    const reckon = makeReckonRoundHandler(node);
    const complete = makeCompleteRoundHandler(node);
    expect(run(reckon, state, makeOp('reckon_round', 'alice', { note: 'settled' } as ReckonRoundPayload))).toBe(0);
    expect(run(complete, state, makeOp('complete_round', 'alice', {
      entries: [{ contributionId: 'r1-a', submitter: 'alice', dims: { '1': 1 } }],
    } as CompleteRoundPayload))).toBe(0);
    expect(logical(state, RES_NAMES.balance('alice'))).toBe(beforeAlice);
    expect(logical(state, RES_NAMES.balance('bob'))).toBe(beforeBob); // unset stays unset
  });
});

describe('RoundEntry harm validation', () => {
  it('accepts entries with valid harm; rejects invalid or wrong-typed harm', () => {
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'reduced' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'none' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'voided' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'kind-of' })).toBe(false);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 2 })).toBe(false);
  });
});
