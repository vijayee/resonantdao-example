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
});
