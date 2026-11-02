// Targeted verification (slice #4c) — Task 1: submit names verifiers (state).
// The submit handler validates the named verifiers (distinct members ≠ the
// submitter, exactly the schema's verify requirement count) and records them
// in an OR-set with a numeric count companion; the true submitter lands in an
// owner set. Legacy payloads without the field keep untargeted behavior.
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { makeSubmitContributionHandler } from '../../shared/src/handlers';
import { CONTRIB_NAMES, STATE_NAMES } from '../../shared/src/policies';
import { ContributionPayload } from '../../shared/src/types';
import { SCHEMA_VERSION } from '../../shared/src/contribution';

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

function makeOp(type: string, signerId: string, payload: object): HandlerOperation {
  return {
    type,
    signerId,
    nodeId: 'browser',
    payload: JSON.stringify(payload),
    resources: [],
  };
}

const GOOD_REF = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };

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

describe('submit names verifiers (targeted verification, slice #4c)', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // Members set seeded with add_member semantics (element = username).
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
  });

  it('A. accepted named submit: the OR-set holds the names, the count register matches, the owner set holds the signer', () => {
    // C_2 schema (dim 2, v2): verify requirement count 1 — one name is exact.
    const res = submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob'] })));
    expect(res).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'bob')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-1'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.verifyCount('c-1'))).toBe(1);
    expect(state.setContains(CONTRIB_NAMES.owner('c-1'), 'alice')).toBe(true);
  });

  it('B. self-named submitter is rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['alice'] })))).toBe(-1);
  });

  it('C. naming a non-member is rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['ghost'] })))).toBe(-1);
  });

  it('D. duplicate names are rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob', 'bob'] })))).toBe(-1);
  });

  it('E. C_1 (verify count 2): exactly two names accepted, one rejected', () => {
    const two = submit(state, makeOp('submit_contribution', 'alice', submitOp({
      contributionId: 'c-heavy', dims: { '1': 1 }, verifiers: ['bob', 'carol'],
    })));
    expect(two).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-heavy'), 'bob')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-heavy'), 'carol')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-heavy'))).toBe(2);
    expect(state.getRegister(CONTRIB_NAMES.verifyCount('c-heavy'))).toBe(2);

    const one = submit(state, makeOp('submit_contribution', 'bob', submitOp({
      contributionId: 'c-short', dims: { '1': 1 }, verifiers: ['carol'],
    })));
    expect(one).toBe(-1);
  });

  it('F. legacy shape (no verifiers field): accepted, count register reads 0 — untargeted', () => {
    const res = submit(state, makeOp('submit_contribution', 'alice', submitOp({})));
    expect(res).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-1'))).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'bob')).toBe(false);
    // Owner is recorded for every submission, targeted or not.
    expect(state.setContains(CONTRIB_NAMES.owner('c-1'), 'alice')).toBe(true);
    // The verify requirement is still stamped (C_2 → 1) but no count means
    // untargeted until the register is > 0.
    expect(state.getRegister(CONTRIB_NAMES.verifyCount('c-1'))).toBe(1);
  });
});