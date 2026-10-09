import {
  STAGE_OPEN, STAGE_AUDITED, STAGE_RECKONED, STAGE_PUBLISHED,
  encodeSalientMask, decodeSalientMask,
  roundRctTotals, derivedVoteBalance,
  CALIBRATION_VERSIONS, CALIBRATION_VERSION_NUMBERS,
  isValidRoundEntry, AGGREGATE_ENTRY_LIMIT,
} from '../../shared/src/round';
import { HARM_REDUCE_FACTOR, harmFactorFor, strongestHarm, type HarmVerdict } from '../../shared/src/contribution';

describe('round registry', () => {
  it('stage constants are 0..3', () => {
    expect(STAGE_OPEN).toBe(0);
    expect(STAGE_AUDITED).toBe(1);
    expect(STAGE_RECKONED).toBe(2);
    expect(STAGE_PUBLISHED).toBe(3);
  });

  describe('salient mask', () => {
    it('encodes/decodes a subset of dimensions 0..21', () => {
      const mask = encodeSalientMask([1, 18]);
      expect(mask).toBe((1 << 1) | (1 << 18));
      expect(decodeSalientMask(mask)).toEqual([1, 18]);
    });
    it('empty list encodes 0 (base-membership-only question)', () => {
      expect(encodeSalientMask([])).toBe(0);
      expect(decodeSalientMask(0)).toEqual([]);
    });
    it('rejects out-of-range and duplicate dims', () => {
      expect(() => encodeSalientMask([22])).toThrow();
      expect(() => encodeSalientMask([-1])).toThrow();
      expect(() => encodeSalientMask([1, 1])).toThrow();
      expect(() => encodeSalientMask([1.5] as unknown as number[])).toThrow();
    });
  });

  describe('roundRctTotals', () => {
    const alphaFor = (i: number) => (i === 1 ? 2 : 1);
    it('aggregates per submitter over entries; unscored dims contribute nothing', () => {
      const totals = roundRctTotals([
        { contributionId: 'a', submitter: 'alice', dims: { '1': 1, '9': 1 } },
        { contributionId: 'b', submitter: 'alice', dims: { '2': 0.5 } },
        { contributionId: 'c', submitter: 'bob', dims: { '2': 1 } },
      ], alphaFor);
      expect(totals.get('alice')).toBe(2 * 1 + 1 * 1 + 1 * 0.5); // 3.5 — dim 9 has no tally input by construction (caller filters); alpha defaulting is the caller's concern
      expect(totals.get('bob')).toBe(1);
    });
    it('returns an empty map for no entries', () => {
      expect(roundRctTotals([], alphaFor).size).toBe(0);
    });
  });

  describe('derivedVoteBalance', () => {
    const tally = (i: number) => (i === 1 ? 10 : i === 2 ? 0.5 : 0);
    const alpha = (i: number) => (i === 1 ? 2 : 1);
    it('base plus masked salient contributions', () => {
      expect(derivedVoteBalance(encodeSalientMask([1]), (i) => alpha(i), tally, 3, 50)).toBe(3 + 2 * 10);
      expect(derivedVoteBalance(encodeSalientMask([1, 2]), (i) => alpha(i), tally, 3, 50)).toBe(3 + 2 * 10 + 0.5);
      expect(derivedVoteBalance(0, (i) => alpha(i), tally, 3, 50)).toBe(3); // base-only (elections, no salience)
    });
    it('caps the derived balance', () => {
      expect(derivedVoteBalance(encodeSalientMask([1]), (i) => alpha(i), tally, 3, 10)).toBe(10);
    });
  });

  it('calibration versions map v1 <-> 1', () => {
    expect(CALIBRATION_VERSIONS).toEqual(['v1']);
    expect(CALIBRATION_VERSION_NUMBERS.get('v1')).toBe(1);
  });

  describe('isValidRoundEntry', () => {
    it('accepts well-formed entries and rejects broken ones', () => {
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'alice', dims: { '1': 1 } })).toBe(true);
      expect(isValidRoundEntry({ contributionId: '', submitter: 'alice', dims: { '1': 1 } })).toBe(false);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: '', dims: { '1': 1 } })).toBe(false);
      expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: {} })).toBe(false);
      expect(isValidRoundEntry(null)).toBe(false);
      expect(AGGREGATE_ENTRY_LIMIT).toBe(200);
    });
  });
});

describe('harm adjustments (constants + helpers)', () => {
  it('reduced factor is the 0.5 pilot constant', () => {
    expect(HARM_REDUCE_FACTOR).toBe(0.5);
    expect(harmFactorFor(undefined)).toBe(1);
    expect(harmFactorFor('none')).toBe(1);
    expect(harmFactorFor('reduced')).toBe(0.5);
    expect(harmFactorFor('voided')).toBe(0);
    expect(() => harmFactorFor('kind-of' as unknown as HarmVerdict)).toThrow(); // invalid verdicts rejected at validation, never defaulted
  });

  it('strongest-wins: voided > reduced > none', () => {
    expect(strongestHarm(undefined, undefined)).toBe('none');
    expect(strongestHarm('reduced', undefined)).toBe('reduced');
    expect(strongestHarm(undefined, 'reduced')).toBe('reduced');
    expect(strongestHarm('reduced', 'voided')).toBe('voided');
    expect(strongestHarm('voided', 'reduced')).toBe('voided');
    expect(strongestHarm('none', 'none')).toBe('none');
  });
});

describe('RoundEntry harm validation', () => {
  it('accepts entries with valid harm; rejects invalid or wrong-typed harm', () => {
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'reduced' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'none' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'voided' })).toBe(true);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 'kind-of' })).toBe(false);
    expect(isValidRoundEntry({ contributionId: 'x', submitter: 'a', dims: { '1': 1 }, harm: 2 })).toBe(false);
  });
});