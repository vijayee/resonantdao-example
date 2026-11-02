// Targeted verification (slice #4c) — Tasks 1-3: submit names verifiers,
// reassign_verifiers grows the set, and the verify handler admits only named
// signers. Legacy payloads without the field keep untargeted behavior.
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import {
  makeAppealVerdictHandler,
  makeReassignVerifiersHandler,
  makeSettleContributionHandler,
  makeSubmitContributionHandler,
  makeVerifyContributionHandler,
} from '../../shared/src/handlers';
import { CHECK_NAMES, CONTRIB_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
import { AppealVerdictPayload, ContributionPayload, ReassignVerifiersPayload, SettleContributionPayload, VerifyContributionPayload } from '../../shared/src/types';
import { SCHEMA_VERSION, STATUS_ACCEPTED, STATUS_APPEALED, STATUS_PENDING, STATUS_REJECTED } from '../../shared/src/contribution';

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

function reassignOp(signerId: string, payload: ReassignVerifiersPayload): HandlerOperation {
  return makeOp('reassign_verifiers', signerId, payload);
}

function verifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
  return makeOp('verify_contribution', signer, {
    contributionId: 'c-1', submitter: 'alice', dims: { '2': 1 }, stepId: 'verify',
    pass: true, reason: 'checks out', schemaVersion: SCHEMA_VERSION,
    ...payload,
  } as VerifyContributionPayload);
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

describe('reassign_verifiers (targeted verification, slice #4c)', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let reassign: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // Members set seeded with add_member semantics (element = username).
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    reassign = makeReassignVerifiersHandler(node, { getTimeMs: () => 1000 });
  });

  it('G. submitter reassign while verify incomplete: the set grows by exactly-remaining, the count follows', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob'] })))).toBe(0);
    // C_2: need 1, done 0 → remaining 1; naming exactly carol is exact.
    const res = reassign(state, reassignOp('alice', {
      contributionId: 'c-1', verifiers: ['carol'],
    }));
    expect(res).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'bob')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'carol')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-1'))).toBe(2);
  });

  it('H. reassign NOT by the submitter is rejected (owner set is the gate)', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob'] })))).toBe(0);
    const res = reassign(state, reassignOp('bob', {
      contributionId: 'c-1', verifiers: ['carol'],
    }));
    expect(res).toBe(-1);
    // Nothing changed.
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'carol')).toBe(false);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-1'))).toBe(1);
  });

  it('I. reassign with the wrong remaining count (naming 2 or 0 when 1 remains) is rejected', () => {
    // C_1: need 2; one check already done → remaining 1.
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({
      contributionId: 'c-heavy', dims: { '1': 1 }, verifiers: ['bob', 'carol'],
    })))).toBe(0);
    state.incrementPNCounter(CONTRIB_NAMES.stepDone('c-heavy', 'verify'), 1);
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-heavy', verifiers: ['dave', 'ghost'],
    }))).toBe(-1);
    const before = state.getRegister(CONTRIB_NAMES.verifierCount('c-heavy'));
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-heavy', verifiers: [],
    }))).toBe(-1);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-heavy'))).toBe(before);
  });

  it('J. reassign naming a non-member / self / duplicate / already-named verifier is rejected', () => {
    // C_1 with 2 slots open: the duplicate/self gates need remaining ≥ 2.
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({
      contributionId: 'c-heavy', dims: { '1': 1 }, verifiers: ['bob', 'carol'],
    })))).toBe(0);
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-heavy', verifiers: ['ghost'],
    }))).toBe(-1);
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-heavy', verifiers: ['dave', 'dave'],
    }))).toBe(-1);
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-heavy', verifiers: ['alice', 'dave'],
    }))).toBe(-1);
    // Grow-only: a name already in the set must not be re-added.
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-heavy', verifiers: ['bob', 'dave'],
    }))).toBe(-1);
    // Nothing landed.
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-heavy'), 'dave')).toBe(false);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-heavy'))).toBe(2);
  });

  it('K. reassign after the verify step COMPLETED is rejected', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob'] })))).toBe(0);
    state.incrementPNCounter(CONTRIB_NAMES.stepDone('c-1', 'verify'), 1);
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-1', verifiers: ['carol'],
    }))).toBe(-1);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'carol')).toBe(false);
  });

  it('L. reassign on an UNTARGETED contribution is rejected (count register 0)', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({})))).toBe(0);
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-1', verifiers: ['carol'],
    }))).toBe(-1);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-1'), 'carol')).toBe(false);
  });

  it('reassign on an unknown contribution (no registers at all) is rejected', () => {
    expect(reassign(state, reassignOp('alice', {
      contributionId: 'c-ghost', verifiers: ['carol'],
    }))).toBe(-1);
  });
});

describe('the verify gate honors the named set (targeted verification, slice #4c)', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let appeal: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // Members set seeded with add_member semantics (element = username).
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    appeal = makeAppealVerdictHandler(node, { getTimeMs: () => 5000 });
  });

  it('M. a NAMED (unbarred) verifier verifies the targeted contribution', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob'] })))).toBe(0);
    const verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    expect(verify(state, verifyOp('bob', { contributionId: 'c-1', submitter: 'alice' }))).toBe(0);
    // v2 schemas are 3-step: a completed verify ADVANCES to settle (the settle
    // op finalizes acceptance, status stays 0 here).
    expect(state.getRegister(CONTRIB_NAMES.step('c-1'))).toBe(2);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(0);
  });

  it('N. an UNNAMED member (otherwise eligible) is rejected — the protocol core', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ verifiers: ['bob'] })))).toBe(0);
    const verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    expect(verify(state, verifyOp('carol', { contributionId: 'c-1', submitter: 'alice' }))).toBe(-1);
    // Nothing mutated: carol paid no per-check credit and the verify never
    // completed.
    expect(state.getRegister(RES_NAMES.balance('carol'))).toBe(0);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-1', 'verify'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(0);
  });

  it('O. an UNTARGETED contribution keeps the legacy class rule (any member but the submitter)', () => {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({})))).toBe(0); // legacy shape → count 0
    const verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    expect(verify(state, verifyOp('carol', { contributionId: 'c-1', submitter: 'alice' }))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-1'))).toBe(2); // advanced to settle
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(0);
  });

  it('P. the named set survives an appeal: the same named verifiers re-verify after the rewind', () => {
    // C_1 (verify count 2): exactly two names; bob rejects (his check completes
    // and terminates the lifecycle), carol stays pre-pair clear.
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({
      contributionId: 'c-appeal', dims: { '1': 1 }, verifiers: ['bob', 'carol'],
    })))).toBe(0);
    const verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    expect(verify(state, verifyOp('bob', { contributionId: 'c-appeal', submitter: 'alice', dims: { '1': 1 }, pass: false, reason: 'insufficient' }))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-appeal'))).toBe(2);
    expect(appeal(state, makeOp('appeal_verdict', 'alice', {
      contributionId: 'c-appeal', submitter: 'alice', reason: 'evidence misread',
    } as AppealVerdictPayload))).toBe(0);

    // The appeal rewound the lifecycle but left the named set untouched.
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-appeal'), 'bob')).toBe(true);
    expect(state.setContains(CONTRIB_NAMES.verifiers('c-appeal'), 'carol')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.verifierCount('c-appeal'))).toBe(2);
    // The SAME named verifiers re-verify. bob's pre-appeal rejection carries a
    // per-pair once bar (independent of the targeted gate — pinned by
    // contribution.test.ts c-app5), so carol (the other name from the SAME
    // pre-appeal set) completes the re-review; the gate passes her because the
    // set she was named in survived.
    expect(verify(state, verifyOp('bob', { contributionId: 'c-appeal', submitter: 'alice', dims: { '1': 1 }, reason: 'changed my mind' }))).toBe(-1);
    expect(verify(state, verifyOp('carol', { contributionId: 'c-appeal', submitter: 'alice', dims: { '1': 1 }, reason: 're-review ok' }))).toBe(0);
    // Carols's is the first completed check of the FRESH quorum (the appeal
    // reset the done counter): done 1 of 2 — the step does not advance yet, and
    // the status stays STATUS_APPEALED until the settle op finalizes.
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-appeal', 'verify'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.step('c-appeal'))).toBe(1);
  });
});

describe('settle/appeal authenticate against the machine-recorded owner (owner-auth retrofit)', () => {
  let node: MockNode;
  let state: MockState;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let settle: (state: HandlerState, op: HandlerOperation) => number;
  let appeal: (state: HandlerState, op: HandlerOperation) => number;
  let verify: (state: HandlerState, op: HandlerOperation) => number;

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
    appeal = makeAppealVerdictHandler(node, { getTimeMs: () => 5000 });
  });

  const settleOp = (signerId: string, contributionId = 'c-1') =>
    makeOp('settle_contribution', signerId, {
      contributionId, submitter: signerId, reason: 'looks good',
    } as SettleContributionPayload);
  const appealOp = (signerId: string, contributionId = 'c-1') =>
    makeOp('appeal_verdict', signerId, {
      contributionId, submitter: signerId, reason: 'evidence misread',
    } as AppealVerdictPayload);

  // Arc helpers — real handlers only (no register surgery), so every arc is
  // owner-stamped by the live submit handler.
  // Submit + a completed untargeted verify → the contribution sits at the
  // settle step (2), status PENDING.
  function verifiedArc(contributionId = 'c-1'): void {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ contributionId })))).toBe(0);
    expect(verify(state, verifyOp('carol', { contributionId, submitter: 'alice' }))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step(contributionId))).toBe(2);
    expect(state.getRegister(CONTRIB_NAMES.status(contributionId))).toBe(STATUS_PENDING);
  }

  // Submit + a rejecting untargeted verify → the lifecycle is terminal REJECTED.
  function rejectedArc(contributionId = 'c-1'): void {
    expect(submit(state, makeOp('submit_contribution', 'alice', submitOp({ contributionId })))).toBe(0);
    expect(verify(state, verifyOp('carol', { contributionId, submitter: 'alice', pass: false, reason: 'insufficient' }))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status(contributionId))).toBe(STATUS_REJECTED);
  }

  it('Q. settle by the TRUE owner (alice on alice\'s submission) finalizes as accepted', () => {
    verifiedArc();
    expect(settle(state, settleOp('alice'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(STATUS_ACCEPTED);
  });

  it('R. settle FORGED (bob claims submitter=bob on ALICE\'s contribution) is refused by the owner set', () => {
    // Untargeted legacy shape is fine — the gate is unconditional. The
    // payload-claim check passed this before; the owner set is what refuses it.
    verifiedArc();
    expect(settle(state, settleOp('bob'))).toBe(-1);
    // Nothing mutated: the lifecycle never finalized and the forger collected
    // no upheld credit (bob completed nothing — the arc's check was carol's).
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(STATUS_PENDING);
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-1', 'verify'))).toBe(1);
    expect(state.getRegister(CHECK_NAMES.upheld('bob'))).toBe(0);
  });

  it('S. appeal FORGED the same way (bob on alice\'s rejected contribution) is refused by the owner set', () => {
    rejectedArc();
    expect(appeal(state, appealOp('bob'))).toBe(-1);
    // Nothing mutated: the once-guard never fired and the lifecycle stays
    // terminal.
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(STATUS_REJECTED);
    expect(state.getRegister(CONTRIB_NAMES.appealed('c-1'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.step('c-1'))).toBe(1);
  });

  it('T. appeal by the TRUE owner after a rejection re-opens the lifecycle (the legal arc)', () => {
    rejectedArc();
    expect(appeal(state, appealOp('alice'))).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.status('c-1'))).toBe(STATUS_APPEALED);
    expect(state.getRegister(CONTRIB_NAMES.appealed('c-1'))).toBe(1);
    expect(state.getRegister(CONTRIB_NAMES.step('c-1'))).toBe(1);
  });
});
