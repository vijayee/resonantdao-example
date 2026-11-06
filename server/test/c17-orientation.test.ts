// C_17 Star (slice #6d) — the orientation contracts. Any member may declare
// themselves the ORIENTATION GUIDE of another member; the FIRST orientation
// of a member wins (the per-orientee once-register), the winning guide's name
// is stamped into the registry OR-set, and the guide's C_17 tally credits at
// the orientee's FIRST proven work (the verify payload re-carries the guide's
// name; the handler cross-checks the re-carry against the stamps).
import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeDeclareOrientationHandler,
  makeSettleContributionHandler,
  makeSubmitContributionHandler,
  makeVerifyContributionHandler,
} from '../../shared/src/handlers';
import { CHECK_NAMES, CONTRIB_NAMES, POLICIES, RECIP_NAMES, RES_NAMES, STATE_NAMES } from '../../shared/src/policies';
import { fromRegisterUnits, toRegisterUnits } from '../../shared/src/contribution';
import {
  ContributionPayload,
  DeclareOrientationPayload,
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

function submitOp(payload: Partial<ContributionPayload>): ContributionPayload {
  return {
    contributionId: 'c-1',
    dims: { '2': 1 },
    summary: 'Wrote an architecture record',
    evidenceRef: GOOD_REF,
    schemaVersion: 'v2',
    ...payload,
  } as ContributionPayload;
}

function orientOp(guide: string, orientee: string): HandlerOperation {
  return makeOp('declare_orientation', guide, { orientee } as DeclareOrientationPayload);
}

describe('C_17 orientation: the declare op is first-wins and stamps the registry', () => {
  let node: MockNode;
  let state: MockState;
  let declare: (state: HandlerState, op: HandlerOperation) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    declare = makeDeclareOrientationHandler(node);
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
  });

  // Contracts:
  // O-A: a happy declare (guide alice, orientee bob) → 0; the registry holds
  //      the guide (setContains(orientedBy(bob), alice)) and the per-orientee
  //      once-register is stamped (oriented(bob) === 1).
  // O-B: a SECOND orientation of the SAME orientee (another guide) → -1 and
  //      the registry is untouched (the first orientation wins).
  // O-C: self-orientation → -1; an orientee (or guide) outside the members
  //      set → -1; nothing stamped.
  // O-D: the class policy is 'role:member OR role:custodian' AND the pairing
  //      line exists on the server node — the #4c lesson: jest mocks don't
  //      enforce policies, so the pairing lines are machine-checked in the
  //      SOURCES (the e2e would only catch a missing line much later). The
  //      client node's pairing joins this check with the client task.
  it('O-A. a happy declare returns 0 and stamps the once-register + the guide registry', () => {
    expect(declare(state, orientOp('alice', 'bob'))).toBe(0);
    expect(state.setContains(CONTRIB_NAMES.orientedBy('bob'), 'alice')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.oriented('bob'))).toBe(1);
  });

  it('O-B. a second orientation of the same orientee is rejected — the first guide stands', () => {
    expect(declare(state, orientOp('alice', 'bob'))).toBe(0);
    expect(declare(state, orientOp('carol', 'bob'))).toBe(-1);
    expect(state.setContains(CONTRIB_NAMES.orientedBy('bob'), 'carol')).toBe(false);
    expect(state.setContains(CONTRIB_NAMES.orientedBy('bob'), 'alice')).toBe(true);
    expect(state.getRegister(CONTRIB_NAMES.oriented('bob'))).toBe(1);
  });

  it('O-C. self-orientation and non-members are rejected', () => {
    expect(declare(state, orientOp('alice', 'alice'))).toBe(-1);
    expect(declare(state, orientOp('alice', 'ghost'))).toBe(-1);
    expect(declare(state, orientOp('ghost', 'bob'))).toBe(-1);
    expect(state.setContains(CONTRIB_NAMES.orientedBy('alice'), 'alice')).toBe(false);
    expect(state.setContains(CONTRIB_NAMES.orientedBy('ghost'), 'alice')).toBe(false);
    expect(state.getRegister(CONTRIB_NAMES.oriented('bob'))).toBe(0);
  });

  it('O-D. the policy line is the member-or-custodian class and is PAIRED on both nodes', () => {
    expect(POLICIES.declare_orientation).toBe('role:member OR role:custodian');
    const serverSrc = readFileSync(join(__dirname, '..', 'src', 'crabs.ts'), 'utf8');
    const clientSrc = readFileSync(join(__dirname, '..', '..', 'client', 'src', 'dao.ts'), 'utf8');
    const pairing = "this.node.setPolicy('declare_orientation', POLICIES.declare_orientation);";
    expect(serverSrc).toContain(pairing);
    expect(clientSrc).toContain(pairing);
  });
});

describe('C_17 verify: the guide’s credit rides the orientee’s FIRST proven work', () => {
  let node: MockNode;
  let state: MockState;
  let declare: (state: HandlerState, op: HandlerOperation) => number;
  let submit: (state: HandlerState, op: HandlerOperation) => number;
  let verify: (state: HandlerState, op: HandlerOperation) => number;
  let settle: (state: HandlerState, op: HandlerOperation) => number;
  let tally: (username: string, dimIndex: number) => number;
  let res: (username: string) => number;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    declare = makeDeclareOrientationHandler(node);
    submit = makeSubmitContributionHandler(node, { getTimeMs: () => 1000 });
    verify = makeVerifyContributionHandler(node, { getTimeMs: () => 2000 });
    settle = makeSettleContributionHandler(node, { getTimeMs: () => 4000 });
    tally = (username, dimIndex) => state.getRegister(CONTRIB_NAMES.dimensionBalance(username, dimIndex));
    res = (username) => fromRegisterUnits(state.getRegister(RES_NAMES.balance(username)));
    for (const u of ['alice', 'bob', 'carol', 'dave']) {
      state.setAdd(STATE_NAMES.members, u, u);
    }
  });

  // alice (the guide) declares bob (the star); bob submits a Recording claim
  // named to carol (targeted per the wired schema); carol's verify payload
  // re-carries { orientedBy: 'alice' } — the client's accessor gates the
  // re-carry; the handler cross-checks it against the declare stamp.
  function orientedClaimArc(): void {
    expect(declare(state, orientOp('alice', 'bob'))).toBe(0);
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({
      contributionId: 'c-star',
      dims: { '2': 1 },
      summary: 'the star’s first proven record',
      verifiers: ['carol'],
    })))).toBe(0);
  }

  function verifyOp(signer: string, payload: Partial<VerifyContributionPayload>): HandlerOperation {
    return makeOp('verify_contribution', signer, {
      contributionId: 'c-star', submitter: 'bob', dims: { '2': 1 }, stepId: 'verify',
      pass: true, reason: 'checks out', schemaVersion: 'v2',
      ...payload,
    } as VerifyContributionPayload);
  }

  // Contracts:
  // V-A: the FIRST verify of the oriented member credits the GUIDE's C_17
  //      tally (match × alphaFor(17), default arc = 1; seeded-arc scaled) and
  //      stamps the first-proven register; the verified work's own bounty and
  //      the actor's per-check credit are untouched by the hook.
  // V-B: the SECOND verify of the same member credits NO C_17 (the
  //      once-register); the re-carry's absence likewise adds nothing.
  // V-C: a forged re-carry (the payload names a member the registry does not
  //      stamp) → -1 with NOTHING moved — no per-check credit, no accuracy
  //      accrual, no reciprocity record, no stepDone, no tally.
  // V-D: no registry + no re-carry → no hook: the un-oriented member's verify
  //      is byte-identical to every pre-#6d arc (no first-proven stamp, no
  //      C_17 register writes).
  it('V-A. the first proven work credits the guide (default arc), stamps first-proven; the arc’s own economics untouched', () => {
    orientedClaimArc();
    expect(verify(state, verifyOp('carol', { orientedBy: 'alice' }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1)); // match 1 × the unset alpha default 1
    expect(state.getRegister(CONTRIB_NAMES.firstProven('bob'))).toBe(1);
    // The verified work's own bounty is unchanged by the hook (bob's C_2 base).
    expect(res('bob')).toBe(3);
    // The verifying actor's per-check credit is carol's, untouched.
    expect(res('carol')).toBe(2);
  });

  it('V-A (scaled). alpha(17) seeded to 2: the SAME arc credits the guide match × 2', () => {
    state.setRegister('config:alpha:17', toRegisterUnits(2), 'custodian');
    orientedClaimArc();
    expect(verify(state, verifyOp('carol', { orientedBy: 'alice' }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1 * 2));
  });

  it('V-B. the second verify of the same member credits NO C_17 (the once-register)', () => {
    orientedClaimArc();
    expect(verify(state, verifyOp('carol', { orientedBy: 'alice' }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1));
    // A second claim of the star's, verified with the SAME re-carry: the
    // once-register holds — the tally does not move.
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({
      contributionId: 'c-star-2',
      dims: { '2': 1 },
      summary: 'the star’s second record',
      verifiers: ['dave'],
    })))).toBe(0);
    expect(verify(state, verifyOp('dave', { contributionId: 'c-star-2', orientedBy: 'alice' }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1));
    // And the re-carry riding a payload WITHOUT the guide's name (the client
    // stops attaching once its mirror sees the stamp) likewise adds nothing.
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({
      contributionId: 'c-star-3',
      dims: { '2': 1 },
      summary: 'the star’s third record',
    })))).toBe(0);
    expect(verify(state, verifyOp('alice', {
      contributionId: 'c-star-3', orientedBy: undefined, priorVerifiers: [],
    }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1));
    expect(res('carol')).toBe(2); // carol's check credit — untouched
    expect(res('alice')).toBe(2); // alice's own check credit — the class rule is intact
  });

  it('V-C. a forged re-carry (a name the registry does not stamp) is rejected — nothing moved', () => {
    orientedClaimArc();
    // carol (a member, clearing membership/owner/targeting/reciprocity legs)
    // is the forged name, so this isolates the guide pin.
    expect(verify(state, verifyOp('carol', { orientedBy: 'carol' }))).toBe(-1);
    expect(res('carol')).toBe(0); // no per-check credit
    expect(state.getRegister(CHECK_NAMES.total('carol'))).toBe(0); // no accuracy accrual
    expect(state.setContains(RECIP_NAMES.verifiedBy('bob'), 'carol')).toBe(false); // no reciprocity record
    expect(state.getPNCounter(CONTRIB_NAMES.stepDone('c-star', 'verify'))).toBe(0);
    expect(tally('bob', 2)).toBe(0); // the outcome never paid
    expect(tally('alice', 17)).toBe(0);
    expect(state.getRegister(CONTRIB_NAMES.firstProven('bob'))).toBe(0);
    // The TRUE guide's re-carry (the registry's stamp) passes.
    expect(verify(state, verifyOp('carol', { orientedBy: 'alice' }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1));
  });

  it('V-D. no registry + no re-carry → no hook: the pre-#6d arc is byte-identical', () => {
    // bob is NEVER oriented; the verify payload carries no orientedBy.
    expect(submit(state, makeOp('submit_contribution', 'bob', submitOp({
      contributionId: 'c-plain',
      dims: { '2': 1 },
      summary: 'an un-oriented record',
      verifiers: ['carol'],
    })))).toBe(0);
    expect(verify(state, verifyOp('carol', {
      contributionId: 'c-plain', orientedBy: undefined,
    }))).toBe(0);
    expect(tally('alice', 17)).toBe(0); // no C_17 register ever written
    expect(state.getRegister(CONTRIB_NAMES.firstProven('bob'))).toBe(0); // no stamp
    expect(res('bob')).toBe(3); // the arc's own economics unchanged
    expect(res('carol')).toBe(2);
  });

  it('(the settled arc completes the shape like every schema; settlement moves no tallies)', () => {
    orientedClaimArc();
    expect(verify(state, verifyOp('carol', { orientedBy: 'alice' }))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1));
    expect(settle(state, makeOp('settle_contribution', 'bob', {
      contributionId: 'c-star', submitter: 'bob', reason: 'the record is real',
    } as SettleContributionPayload))).toBe(0);
    expect(tally('alice', 17)).toBe(toRegisterUnits(1));
    expect(res('bob')).toBe(3);
  });
});
