import { DIMENSION_COUNT, isValidDims, isValidHarm, type HarmVerdict } from './contribution';

// Round spine stages (C_10 audit → C_20 reckon → C_21 complete/publish).
export const STAGE_OPEN = 0 as const;
export const STAGE_AUDITED = 1 as const;
export const STAGE_RECKONED = 2 as const;
export const STAGE_PUBLISHED = 3 as const;

// Justice-calibration versions (page: "Judgement cannot finalize a cycle
// without a current Justice calibration"). 'v1' is the pilot's only version;
// registration stores the numeric index.
export const CALIBRATION_VERSIONS = ['v1'] as const;
export const CALIBRATION_VERSION_NUMBERS = new Map<string, number>(
  CALIBRATION_VERSIONS.map((v, i) => [v, i + 1])
);

export const AGGREGATE_ENTRY_LIMIT = 200 as const;

export interface RoundEntry {
  contributionId: string;
  submitter: string;
  // The RECIPIENT of the work when the claim is not self-proclaimed (the
  // entry carries it iff the claim recognized someone else). Absent = the
  // submitter attributes to themselves.
  recipient?: string;
  dims: Record<string, number>;
  harm?: HarmVerdict;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function isValidRoundEntry(entry: unknown): entry is RoundEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Partial<RoundEntry>;
  // recipient is an OPTIONAL additive field (slice #6b): absent is fine (self-
  // claim), and when present it must at least be a non-empty string — the
  // membership/stamp cross-check that gives it authority lives in the
  // complete_round handler, not here.
  return (
    isNonEmptyString(e.contributionId) && isNonEmptyString(e.submitter) && isValidDims(e.dims) && isValidHarm(e.harm) &&
    (e.recipient === undefined || isNonEmptyString(e.recipient))
  );
}

export function encodeSalientMask(dims: number[]): number {
  if (!Array.isArray(dims)) throw new Error('salient dims must be an array');
  const seen = new Set<number>();
  for (const d of dims) {
    if (!Number.isInteger(d) || d < 0 || d >= DIMENSION_COUNT) {
      throw new Error(`invalid salient dimension: ${d}`);
    }
    if (seen.has(d)) throw new Error(`duplicate salient dimension: ${d}`);
    seen.add(d);
  }
  let mask = 0;
  for (const d of seen) mask |= 1 << d;
  return mask;
}

export function decodeSalientMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < DIMENSION_COUNT; i++) {
    if ((mask & (1 << i)) !== 0) out.push(i);
  }
  return out;
}

// RCT attribution (Victor, 2026-11-02): RCT is the contribution token — it
// defines VOTING POWER and goes to the RECIPIENT of the work, not the filer.
// Self-proclaimed claims (submit your own work) are the degenerate case —
// recipient = submitter — legitimate because third parties verify.
//
// Aggregate a round's settled contributions into per-member totals keyed by
// that attribution rule (entry.recipient ?? entry.submitter). The caller
// decides alpha semantics (default weight handling happens there).
export function roundRctTotals(
  entries: RoundEntry[],
  alphaFor: (dimIndex: number) => number
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.recipient ?? entry.submitter;
    let sum = totals.get(key) ?? 0;
    for (const [dimKey, match] of Object.entries(entry.dims)) {
      sum += alphaFor(Number(dimKey)) * match;
    }
    totals.set(key, sum);
  }
  return totals;
}

// Pilot voting model: base membership + bounded multiplier from salient
// balances, capped; the pre-existing quadratic cost machinery consumes this
// balance. Unscored (unscored-dimension) members simply contribute base.
export function derivedVoteBalance(
  salientMask: number,
  alphaFor: (dimIndex: number) => number,
  tallyFor: (dimIndex: number) => number,
  base: number,
  cap: number
): number {
  let balance = base;
  for (let i = 0; i < DIMENSION_COUNT; i++) {
    if ((salientMask & (1 << i)) === 0) continue;
    balance += alphaFor(i) * tallyFor(i);
  }
  return balance > cap ? cap : balance;
}
