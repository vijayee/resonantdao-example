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
