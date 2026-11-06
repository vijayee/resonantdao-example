import { validateStep, flowSteps, FlowDefinition, FlowStep } from '../../client/src/wizard/types';
import { claimTieSteps } from '../../client/src/wizard/flows/claim-steps';

describe('validateStep', () => {
  const choice: FlowStep = { kind: 'choice', id: 'decision', title: 'Decision', options: [] };
  const text: FlowStep = { kind: 'text', id: 'reason', title: 'Reason' };
  const review: FlowStep = { kind: 'review' };

  it('requires exactly one choice selection', () => {
    expect(validateStep(choice, {})).toBe('Choose one to continue.');
    expect(validateStep(choice, { decision: '' })).toBe('Choose one to continue.');
    expect(validateStep(choice, { decision: 'yes' })).toBeNull();
  });

  it('requires non-empty trimmed text', () => {
    expect(validateStep(text, {})).toBe('A written note is required.');
    expect(validateStep(text, { reason: '   ' })).toBe('A written note is required.');
    expect(validateStep(text, { reason: ' checks out ' })).toBeNull();
  });

  it('review steps are always valid', () => {
    expect(validateStep(review, {})).toBeNull();
  });

  it('members steps require EXACTLY count selections', () => {
    // The screened eligible list rides on the kind (options); the answer
    // serializes as a comma-joined string of the picked names. count may be a
    // number or a function of the answers so far (slice #4c: targeted
    // verification needs the schema's verify requirement count).
    const fixed: FlowStep = { kind: 'members', id: 'verifiers', title: 'Verifiers', options: ['bob', 'carol'], count: 1 };
    const dynamic: FlowStep = {
      kind: 'members', id: 'verifiers', title: 'Verifiers', options: ['bob', 'carol'],
      count: (a) => Number(a.dim === '1' ? 2 : 1),
    };
    expect(validateStep(fixed, {})).toBe('Choose exactly 1 verifier(s).');
    expect(validateStep(fixed, { verifiers: 'bob' })).toBeNull();
    expect(validateStep(dynamic, { dim: '1', verifiers: 'bob' })).toBe('Choose exactly 2 verifier(s).');
    expect(validateStep(dynamic, { dim: '1', verifiers: 'bob,carol' })).toBeNull();
  });

  it('evidence steps are optional (both paths empty is valid)', () => {
    // One new kind in slice #4b: the submit wizard's evidence step. BOTH
    // inputs are optional at the shell — the store's own gate
    // ('Attach evidence or give a pointer') is the authority that rejects
    // submitting with nothing, at the submit boundary.
    const evidence: FlowStep = { kind: 'evidence', id: 'evidence', title: 'Evidence', pointerPlaceholder: 'URL, commit, record id…' };
    expect(validateStep(evidence, {})).toBeNull();
    expect(validateStep(evidence, { evidence: 'https://example.com/e1' })).toBeNull();
  });
});

describe('flowSteps', () => {
  const text: FlowStep = { kind: 'text', id: 'reason', title: 'Reason' };
  const review: FlowStep = { kind: 'review' };

  it('FlowDefinition steps may be a function of the answers (the claim family varies per type)', () => {
    // A structural test: the fn form compiles + the type is honest. Slice
    // #6a: the contribute-new flow varies its step LIST by the chosen type —
    // C_19 gains the recognized-member + record-tie picks; C_1/C_2 walk the
    // plain 5-step form.
    const flow: FlowDefinition = {
      id: 'claim', title: 'Claim',
      steps: (a) => (a.dim === '19' ? [text, review] : [review]),
      reviewSummary: () => [],
      submit: async () => {},
    };
    expect(typeof flow.steps).toBe('function');
    expect(flowSteps(flow, { dim: '19' })).toEqual([text, review]);
    expect(flowSteps(flow, { dim: '2' })).toEqual([review]);
  });

  it('FlowDefinition steps may stay a plain list (the static flows unchanged)', () => {
    const flow: FlowDefinition = {
      id: 'settle', title: 'Settle',
      steps: [review],
      reviewSummary: () => [],
      submit: async () => {},
    };
    expect(Array.isArray(flow.steps)).toBe(true);
    expect(flowSteps(flow, { dim: '19' })).toEqual([review]);
  });
});

// The claim family's tie steps (slices #6a/#6e): the contribute-new factory's
// dynamic picks, reduced to a pure function of the dim answer + the mirror's
// read (the store-read options arrive as plain params, so the derivation is
// testable without the browser store). Contract per the registry's derivation
// (contribution.test.ts's picker pin): only the wired claim dims gain steps —
// plain walks (C_1, C_2) and the embedded rule (C_18) get none.
describe('claimTieSteps — the claim flows walk their ties per the dim answer', () => {
  // A members-kind step, assertively narrowed: kind + id are part of the
  // contract (the shell renders the class from the id), so this helper both
  // narrows the union and pins the ids.
  function memberStep(step: FlowStep, id: string): Extract<FlowStep, { kind: 'members' }> {
    expect(step.kind).toBe('members');
    expect((step as Extract<FlowStep, { kind: 'members' }>).id).toBe(id);
    return step as Extract<FlowStep, { kind: 'members' }>;
  }

  // A structural fake of the store/mirror read: the members list and the
  // accepted contributions (id + submitter) the tie picks screen by.
  const world = {
    members: ['alice', 'bob', 'carol'],
    username: 'alice',
    acceptedContributions: [
      { id: 'r-bob-1', submitter: 'bob' },
      { id: 'r-bob-2', submitter: 'bob' },
      { id: 'r-alice-1', submitter: 'alice' },
      { id: 'r-carol-1', submitter: 'carol' },
    ],
  };

  it('C_19 keeps its two picks: the recognized member (non-self) + the recognizer’s OWN accepted records', () => {
    const steps = claimTieSteps(19, {}, world);
    expect(steps).toHaveLength(2);
    const recognized = memberStep(steps[0], 'recognized');
    const record = memberStep(steps[1], 'record');
    expect([recognized.options, record.options]).toEqual([['bob', 'carol'], ['r-alice-1']]);
  });

  it('C_5 gains the taught pick + the DYNAMIC record pick: the TAUGHT member’s accepted records', () => {
    const steps = claimTieSteps(5, { taught: 'bob' }, world);
    expect(steps).toHaveLength(2);
    const taught = memberStep(steps[0], 'taught');
    const record = memberStep(steps[1], 'record');
    // The taught screen: members minus the filer (bob, carol); the record
    // options are the CHOSEN taught member's accepted records only — alice's
    // and carol's records are never offered on a claim teaching bob.
    expect([taught.options, record.options]).toEqual([['bob', 'carol'], ['r-bob-1', 'r-bob-2']]);
  });

  it('the C_5 record options re-read per the chosen taught member — a taught member with no accepted work yields empty options', () => {
    // carol's record IS offered when carol is taught — a different answer
    // reads a different list (the derivation is dynamic per the taught pick).
    const steps = claimTieSteps(5, { taught: 'carol' }, world);
    expect(memberStep(steps[1], 'record').options).toEqual(['r-carol-1']);
    // An empty mirror gives the same claim empty options — the members
    // picker's exact-count gate makes Next unpassable (the machine's -1
    // mirrors it server-side).
    const empty = claimTieSteps(5, { taught: 'carol' }, { ...world, acceptedContributions: [] });
    expect(memberStep(empty[1], 'record').options).toEqual([]);
  });

  it('plain walks and the embedded rule gain no tie steps', () => {
    expect(claimTieSteps(1, {}, world)).toEqual([]);
    expect(claimTieSteps(2, {}, world)).toEqual([]);
    expect(claimTieSteps(18, {}, world)).toEqual([]);
  });
});
