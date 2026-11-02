import { validateStep, flowSteps, FlowDefinition, FlowStep } from '../../client/src/wizard/types';

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
