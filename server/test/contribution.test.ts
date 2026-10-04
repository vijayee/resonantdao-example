import {
  DIMENSIONS, DIMENSION_COUNT, isValidDims, paymentFor, CALIBRATION_VERSION,
} from '../../shared/src/contribution';
import { RES_CONFIG } from '../../shared/src/policies';

describe('contribution registry', () => {
  it('defines exactly 22 dimensions indexed C_0..C_21', () => {
    expect(DIMENSIONS.length).toBe(22);
    expect(DIMENSION_COUNT).toBe(22);
    DIMENSIONS.forEach((d, i) => expect(d.index).toBe(i));
    expect(DIMENSIONS[1].code).toBe('C_1');
    expect(DIMENSIONS[1].name).toBe('Magician');
    expect(DIMENSIONS[18].name).toBe('Moon');
  });

  it('marks exactly C_1, C_2 and C_18 as implemented for payment', () => {
    const implemented = DIMENSIONS.filter((d) => d.implemented).map((d) => d.index);
    expect(implemented.sort((a, b) => a - b)).toEqual([1, 2, 18]);
  });

  describe('isValidDims', () => {
    it('accepts a sparse map of valid indices with weights in (0, 1]', () => {
      expect(isValidDims({ '1': 1, '2': 0.5 })).toBe(true);
      expect(isValidDims({ '18': 0.25 })).toBe(true);
    });
    it('rejects bad indices, weights, and shapes', () => {
      expect(isValidDims({})).toBe(false);
      expect(isValidDims({ '-1': 1 })).toBe(false);
      expect(isValidDims({ '22': 1 })).toBe(false);
      expect(isValidDims({ '1.5': 1 })).toBe(false);
      expect(isValidDims({ '1': 0 })).toBe(false);
      expect(isValidDims({ '1': 2 })).toBe(false);
      expect(isValidDims({ '01': 1 })).toBe(false);
      expect(isValidDims({ '1': Infinity })).toBe(false);
      expect(isValidDims({ '1': -0.5 })).toBe(false);
      expect(isValidDims([1, 2])).toBe(false);
      expect(isValidDims(null)).toBe(false);
    });
  });

  it('pays building and recording bounties scaled by match weight', () => {
    expect(paymentFor(1, 1)).toBe(RES_CONFIG.buildingBounty);
    expect(paymentFor(2, 0.5)).toBe(RES_CONFIG.recordingBaseCredit * 0.5);
  });
  it('pays nothing for dimensions without implemented rules', () => {
    expect(paymentFor(0, 1)).toBe(0);
    expect(paymentFor(18, 1)).toBe(0); // C_18 pays the verifier, not the submitter
    expect(paymentFor(7, 1)).toBe(0);
  });
  it('has a stable calibration version string', () => {
    expect(CALIBRATION_VERSION).toBe('v1');
  });
});

import {
  CONTENT_LIMITS, SCHEMA_VERSION, SCHEMAS, DEFAULT_SCHEMA,
  schemaForDims, validateEvidenceRef, stepPaymentsFor,
} from '../../shared/src/contribution';

describe('step schemas', () => {
  it('version is v1 and content limits are set', () => {
    expect(SCHEMA_VERSION).toBe('v1');
    expect(CONTENT_LIMITS.maxObjectBytes).toBe(8 * 1024 * 1024);
    expect(CONTENT_LIMITS.maxInlineEvidenceChars).toBe(2000);
  });

  it('wires C_1, C_2, C_18 as 3-step submit->verify->settle schemas', () => {
    for (const dim of [1, 2, 18]) {
      const schema = SCHEMAS.get(dim)!;
      expect(schema.dimIndex).toBe(dim);
      expect(schema.schemaVersion).toBe('v1');
      expect(schema.steps.map((s) => s.stepId)).toEqual(['submit', 'verify', 'settle']);
      expect(schema.steps[0].op).toBe('submit_contribution');
      expect(schema.steps[1].op).toBe('verify_contribution');
      expect(schema.steps[2].op).toBe('settle_contribution');
      expect(schema.steps[1].actors).toContain('verifier');
      expect(schema.steps[1].antiGaming).toContain('no-self');
      expect(schema.steps[1].antiGaming).toContain('written-reason');
    }
  });

  it('defines a 2-step default schema for unwired dimensions', () => {
    expect(DEFAULT_SCHEMA.steps.map((s) => s.stepId)).toEqual(['submit', 'verify']);
    expect(schemaForDims({ '9': 1 }).dimIndex).toBe(-1);
    expect(schemaForDims({ '9': 1 })).toBe(DEFAULT_SCHEMA);
  });

  it('resolves the schema of the lowest wired dimIndex (deterministic priority)', () => {
    expect(schemaForDims({ '1': 0.5, '2': 1 }).dimIndex).toBe(1);
    expect(schemaForDims({ '18': 1, '2': 1 }).dimIndex).toBe(2);
    expect(schemaForDims({ '18': 1 }).dimIndex).toBe(18);
  });

  it('verify steps pay the actor per check and the submitter per dims', () => {
    const step = SCHEMAS.get(1)!.steps[1];
    const pays = stepPaymentsFor(step, { '1': 1, '2': 0.5 },
      { actor: 'bob', submitter: 'alice' });
    expect(pays.get('bob')).toBe(RES_CONFIG.verificationCheckCredit);
    expect(pays.get('alice')).toBe(RES_CONFIG.buildingBounty * 1 + RES_CONFIG.recordingBaseCredit * 0.5);
  });

  describe('validateEvidenceRef', () => {
    const good = { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 };
    it('accepts well-formed refs', () => expect(validateEvidenceRef(good)).toBe(true));
    it('rejects malformed refs', () => {
      expect(validateEvidenceRef({ ...good, hash: 'zz' })).toBe(false);
      expect(validateEvidenceRef({ ...good, uri: '' })).toBe(false);
      expect(validateEvidenceRef({ ...good, mediaType: '' })).toBe(false);
      expect(validateEvidenceRef({ ...good, size: -1 })).toBe(false);
      expect(validateEvidenceRef({ ...good, hash: 'zz'.repeat(32) })).toBe(false);
      expect(validateEvidenceRef(null)).toBe(false);
    });
  });
});
