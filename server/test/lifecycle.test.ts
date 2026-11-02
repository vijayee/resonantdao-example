import { lifecycleModel, isParticipant, LifecycleModel } from '../../client/src/wizard/lifecycle';
import { SCHEMAS } from '../../shared/src/contribution';
import { ContributionFacts } from '../../shared/src/wizard';
import { ContributionMirrorEntry } from '../../client/src/dao';
import type { FeedEvent } from '../../shared/src/feed';

const schema = SCHEMAS.get(2)!; // C_2: submit → verify → settle (single verify)

function entry(overrides: Partial<ContributionMirrorEntry> = {}): ContributionMirrorEntry {
  return {
    record: {
      contributionId: 'c-1',
      dims: { '2': 1 },
      summary: 'Built a shelf',
      evidenceRef: { hash: 'h1', uri: 'https://example.com/e', mediaType: 'text/uri-list', size: 30 },
      schemaVersion: 'v2',
    },
    submitter: 'alice',
    submittedAt: 1000,
    ...overrides,
  } as ContributionMirrorEntry;
}
const facts = (stepIndex: number, done: Record<string, number>, status = 0): ContributionFacts =>
  ({ status, stepIndex, done, submitter: 'alice' });

function verifyEvent(actor: string, at: number): FeedEvent {
  return { index: 1, type: 'contribution_verified', actor, at, round: 1, summary: 'x', targetId: 'c-1' };
}

describe('lifecycleModel', () => {
  it('renders submitted state: submit done (who/when), verify current + waiting, settle locked', () => {
    const m: LifecycleModel = lifecycleModel(schema, facts(1, { submit: 1 }), entry(), 'bob', false, []);
    expect(m.outcome).toBe('pending');
    const [sub, ver, set] = m.phases;
    expect(sub.state).toBe('complete');
    expect(sub.doneBy).toBe('alice');
    expect(sub.doneAt).toBe(1000);
    expect(ver.state).toBe('current');
    expect(ver.mayAct).toBe(true);        // bob may verify (no-self bars only alice)
    expect(ver.flow).toBeUndefined();     // flows are attached page-side, never in the pure model
    expect(set.state).toBe('locked');
  });

  it('waiting text is ROLE-based, never a member name (the domain cannot know who acts next)', () => {
    const m = lifecycleModel(schema, facts(1, { submit: 1 }), entry(), 'carol', false, []);
    expect(m.phases[1].mayAct).toBe(true);    // carol also eligible — the model says WHO MAY act, not who will
    const notMine = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry(), 'bob', false, []);
    expect(notMine.phases[2].mayAct).toBe(false);
    expect(notMine.phases[2].waitingOn).toMatch(/submitter/i);
  });

  it('targeted verify waits on NAMED people; untargeted keeps the role text', () => {
    // facts carry the targeting — the waiting text names the remaining:
    const daveLocked = lifecycleModel(schema, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice', verifiers: ['bob'] }, entry(), 'dave', false, []);
    expect(daveLocked.phases[1].mayAct).toBe(false);
    expect(daveLocked.phases[1].waitingOn).toMatch(/bob/);
    // a named verifier may act — no waiting text on his view
    const named = lifecycleModel(schema, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice', verifiers: ['bob'] }, entry(), 'bob', false, []);
    expect(named.phases[1].mayAct).toBe(true);
    expect(named.phases[1].waitingOn).toBeUndefined();
    // partially targeted: only the REMAINING names show
    const partial = lifecycleModel(schema, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice', verifiers: ['bob', 'carol'] }, entry({ verifiedBy: 'bob', verifiers: ['bob'] }), 'dave', false, []);
    expect(partial.phases[1].waitingOn).toMatch(/carol/);
    expect(partial.phases[1].waitingOn).not.toMatch(/bob/);
    // untargeted (no verifiers field): the legacy role text stands — visible
    // only from a viewer who may NOT act (the submitter: no-self bars her).
    const legacy = lifecycleModel(schema, { status: 0, stepIndex: 1, done: { submit: 1 }, submitter: 'alice' }, entry(), 'alice', false, []);
    expect(legacy.phases[1].mayAct).toBe(false);
    expect(legacy.phases[1].waitingOn).toMatch(/verifier/i);
    expect(legacy.phases[1].waitingOn).not.toMatch(/bob|carol|dave/);
  });

  it('verified step annotates who verified (mirror names) + when (feed event, degrading)', () => {
    const m = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry({ verifiedBy: 'bob', verifiers: ['bob'] }), 'carol', false, [verifyEvent('bob', 2000)]);
    const ver = m.phases[1];
    expect(ver.state).toBe('complete');
    expect(ver.doneBy).toBe('bob');
    expect(ver.doneAt).toBe(2000);
    // Degrade: no matching event → who stays, when drops.
    const m2 = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry({ verifiedBy: 'bob', verifiers: ['bob'] }), 'carol', false, []);
    expect(m2.phases[1].doneBy).toBe('bob');
    expect(m2.phases[1].doneAt).toBeUndefined();
  });

  it('settled outcome renders the terminal banner data + allComplete', () => {
    const acc = lifecycleModel(schema, facts(3, { submit: 1, verify: 1, settle: 1 }, 1), entry({ settledBy: 'alice' }), 'bob', false, []);
    expect(acc.outcome).toBe('accepted');
    expect(acc.phases.map((p) => p.state)).toEqual(['complete', 'complete', 'complete']);
    const rej = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }, 2), entry({ verdict: false, verdictReason: 'not findable', verifiedBy: 'bob' }), 'alice', false, []);
    expect(rej.outcome).toBe('rejected');
    expect(rej.phases[1].note).toBe('not findable');
  });

  it('unknown schema version / unknown lifecycle renders read-only phases without turn info', () => {
    const m = lifecycleModel(schema, { status: -1, stepIndex: 0, done: { submit: 1 }, submitter: 'alice' }, entry(), 'bob', false, []);
    expect(m.readOnly).toBe(true);
    expect(m.phases.every((p) => p.mayAct === false)).toBe(true);
  });

  it('all-parties partial verify shows progress and stays current', () => {
    const c1 = SCHEMAS.get(1)!;
    const m = lifecycleModel(c1, facts(1, { submit: 1, verify: 1 }), entry({ record: { contributionId: 'c-1', dims: { '1': 1 }, summary: 'x', evidenceRef: { hash: 'h', uri: 'u', mediaType: 'text/uri-list', size: 3 }, schemaVersion: 'v2' }, verifiedBy: 'bob', verifiers: ['bob'] } as Partial<ContributionMirrorEntry>), 'carol', false, []);
    expect(m.phases[1].state).toBe('current');
    expect(m.phases[1].progress).toEqual({ done: 1, required: 2 });
    // The partial phase shows no verdict note — note rides DONE phases only.
    expect(m.phases[1].note).toBeUndefined();
  });

  it('a completed two-verifier phase credits BOTH verifiers', () => {
    const c1 = SCHEMAS.get(1)!;
    const mirror: Partial<ContributionMirrorEntry> = {
      record: { contributionId: 'c-1', dims: { '1': 1 }, summary: 'x', evidenceRef: { hash: 'h', uri: 'u', mediaType: 'text/uri-list', size: 3 }, schemaVersion: 'v2' },
      verifiedBy: 'carol', verifiers: ['bob', 'carol'],
    };
    const m = lifecycleModel(c1, facts(2, { submit: 1, verify: 2 }), entry(mirror as Partial<ContributionMirrorEntry>), 'alice', false, [verifyEvent('bob', 2000), verifyEvent('carol', 3000)]);
    expect(m.phases[1].state).toBe('complete');
    expect(m.phases[1].doneBy).toBe('bob & carol');
    expect(m.phases[1].doneAt).toBe(3000);
  });

  it('the completion timestamp is order-independent on the feed array (dao serves newest-first)', () => {
    const m = lifecycleModel(schema, facts(2, { submit: 1, verify: 1 }), entry({ verifiedBy: 'bob', verifiers: ['bob'] }), 'carol', false, [verifyEvent('bob', 2000), verifyEvent('alice', 1000)]);
    // newest-first (as the dao's accessor serves it): bob's 2000 is the
    // completion at; the older event must not win by array position.
    expect(m.phases[1].doneAt).toBe(2000);
  });
});

describe('isParticipant', () => {
  const factsOpen = facts(1, { submit: 1 });
  it('submitter is always a participant', () => {
    expect(isParticipant(entry(), 'alice', false, schema, factsOpen)).toBe(true);
  });
  it('an eligible actor at the current step participates', () => {
    expect(isParticipant(entry(), 'bob', false, schema, factsOpen)).toBe(true);   // verifier role
    expect(isParticipant(entry(), 'carol', false, schema, factsOpen)).toBe(true); // verifiers are a class, not a fixed person
  });
  it('custodians see everything; outsiders at terminal steps stay out (already-acted keeps prior verifiers in)', () => {
    expect(isParticipant(entry(), 'dave', true, schema, factsOpen)).toBe(true);
    const settled = facts(3, { submit: 1, verify: 1, settle: 1 }, 1);
    expect(isParticipant(entry({ verifiers: ['bob'] } as Partial<ContributionMirrorEntry>), 'bob', false, schema, settled)).toBe(true);
    expect(isParticipant(entry(), 'dave', false, schema, settled)).toBe(false);
    expect(isParticipant(entry(), 'dave', false, schema, factsOpen)).toBe(true); // dave may STILL act (eligible verifier class)
  });
});
