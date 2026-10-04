import { DEFAULT_SCHEMA, SCHEMAS, DimensionSchema, SCHEMA_VERSION, StepDef } from '../../shared/src/contribution';
import { wizardModel, ContributionFacts } from '../../shared/src/wizard';

function c1Facts(stepIndex: number, done: Record<string, number>, status = 0): ContributionFacts {
  return { status, stepIndex, done, submitter: 'alice' };
}

describe('wizardModel', () => {
  const schema = SCHEMAS.get(1)!; // C_1: submit → verify → settle

  it('marks completed steps and the current step; later steps locked', () => {
    const m = wizardModel(schema, c1Facts(1, { submit: 1 }), 'alice');
    expect(m.currentStepIndex).toBe(1);
    expect(m.outcome).toBe('pending');
    expect(m.readOnly).toBe(false);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.steps.map((s) => s.state)).toEqual(['complete', 'current', 'locked']);
  });

  it('offers the settle action only to the submitter at the settle step', () => {
    const m = wizardModel(schema, c1Facts(2, { submit: 1, verify: 1 }), 'alice');
    const settle = m.steps[2];
    expect(settle.state).toBe('current');
    expect(settle.roles.submitter?.mayAct).toBe(true);
    // A different viewer at the same step: submitter-only action is not offered.
    const m2 = wizardModel(schema, c1Facts(2, { submit: 1, verify: 1 }), 'bob');
    expect(m2.steps[2].roles.submitter?.mayAct).toBe(false);
  });

  it('offers verify to anyone except the submitter (no-self)', () => {
    const m = wizardModel(schema, c1Facts(1, { submit: 1 }), 'bob');
    // verify step's actors are verifiers only — no submitter role entry at all
    expect(m.steps[1].roles.submitter?.mayAct).toBeFalsy();
    // bob is a potential verifier: verify action offered
    expect(m.steps[1].roles['verifier']?.mayAct).toBe(true);
    const mSelf = wizardModel(schema, c1Facts(1, { submit: 1 }), 'alice');
    expect(mSelf.steps[1].roles['verifier']?.mayAct).toBe(false);
  });

  it('reflects all-parties progress with partial completion still current', () => {
    const schemaAll: DimensionSchema = {
      dimIndex: 8,
      schemaVersion: SCHEMA_VERSION,
      steps: [
        DEFAULT_SCHEMA.steps[0],
        { ...SCHEMAS.get(1)!.steps[1], actors: ['verifier'], requirement: { mode: 'all-parties', count: 2 } },
      ],
    };
    const half = wizardModel(schemaAll, c1Facts(1, { submit: 1, verify: 1 }), 'carol');
    expect(half.steps[1].state).toBe('current');
    expect(half.steps[1].progress).toEqual({ done: 1, required: 2 });
    const full = wizardModel(schemaAll, c1Facts(2, { submit: 1, verify: 2 }), 'carol');
    expect(full.steps[1].state).toBe('complete');
  });

  it('settled outcomes render all steps complete with the verdict', () => {
    const accepted = wizardModel(schema, c1Facts(3, { submit: 1, verify: 1, settle: 1 }, 1), 'alice');
    expect(accepted.outcome).toBe('accepted');
    expect(accepted.currentStepIndex).toBe(-1);
    expect(accepted.steps.every((s) => s.state === 'complete')).toBe(true);
    const rejected = wizardModel(DEFAULT_SCHEMA, c1Facts(1, { submit: 1, verify: 1 }, 2), 'alice');
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.steps.every((s) => s.state === 'complete')).toBe(true);
  });

  it('surfaces an unknown schema version as read-only', () => {
    const stale: DimensionSchema = { ...schema, schemaVersion: 'v0' };
    const m = wizardModel(stale, c1Facts(1, { submit: 1 }), 'alice');
    expect(m.readOnly).toBe(true);
    expect(m.outcome).toBe('pending');
    expect(m.currentStepIndex).toBe(-1);
    expect(m.steps.every((s) => s.state === 'locked')).toBe(true);
  });

  it('gates custodian-actor steps on viewerIsCustodian', () => {
    const custodianStep: StepDef = {
      stepId: 'custody-check',
      title: 'Custodian check',
      requirement: { mode: 'single', count: 1 },
      actors: ['custodian'],
      op: 'verify_contribution',
    };
    const custSchema: DimensionSchema = {
      dimIndex: 1,
      schemaVersion: SCHEMA_VERSION,
      steps: [DEFAULT_SCHEMA.steps[0], custodianStep],
    };
    const facts = c1Facts(1, { submit: 1 });
    const asCustodian = wizardModel(custSchema, facts, 'dana', true);
    expect(asCustodian.steps[1].roles['custodian']?.mayAct).toBe(true);
    const asNonCustodian = wizardModel(custSchema, facts, 'dana', false);
    expect(asNonCustodian.steps[1].roles['custodian']?.mayAct).toBe(false);
  });

  it('offers no actions on locked or completed steps', () => {
    // Pending mid-lifecycle: later steps are locked.
    const pending = wizardModel(schema, c1Facts(1, { submit: 1 }), 'alice');
    expect(pending.steps[0].state).toBe('complete');
    expect(pending.steps[0].roles).toEqual({});
    expect(pending.steps[2].state).toBe('locked');
    expect(pending.steps[2].roles).toEqual({});
    // Settled: everything complete, nothing actionable.
    const settled = wizardModel(schema, c1Facts(3, { submit: 1, verify: 1, settle: 1 }, 1), 'alice');
    for (const step of settled.steps) {
      expect(step.roles).toEqual({});
    }
  });
});