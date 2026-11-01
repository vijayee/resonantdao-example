import { validateStep, FlowStep } from '../../client/src/wizard/types';

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
