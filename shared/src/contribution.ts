// Contribution economy registry — mirrors docs/contribution-economy/README.md
// and docs/superpowers/specs/2026-09-16-contribution-economy-workflows-design.md.
// Phase 1 implements payment rules only for C_1 (building), C_2 (recording)
// and C_18 (verifying); other dimensions classify actions into the 22-vector
// but pay nothing.

import { RES_CONFIG } from './policies';

export interface DimensionDef {
  index: number;
  code: string;
  name: string;
  cls: string; // ontology class from docs/contribution-economy/diagrams.json
  implemented: boolean; // has a phase-1 RES payment rule
}

export const DIMENSION_COUNT = 22 as const;

export const DIMENSIONS: DimensionDef[] = [
  { index: 0,  code: 'C_0',  name: 'Fool',       cls: 'Crossing',    implemented: false },
  { index: 1,  code: 'C_1',  name: 'Magician',   cls: 'Building',    implemented: true },
  { index: 2,  code: 'C_2',  name: 'Priestess',  cls: 'Recording',   implemented: true },
  { index: 3,  code: 'C_3',  name: 'Empress',    cls: 'Nurturing',   implemented: false },
  { index: 4,  code: 'C_4',  name: 'Emperor',    cls: 'Structuring', implemented: false },
  { index: 5,  code: 'C_5',  name: 'Hierophant', cls: 'Teaching',    implemented: false },
  { index: 6,  code: 'C_6',  name: 'Lovers',     cls: 'Joining',     implemented: false },
  { index: 7,  code: 'C_7',  name: 'Chariot',    cls: 'Driving',     implemented: false },
  { index: 8,  code: 'C_8',  name: 'Strength',   cls: 'Resolving',   implemented: false },
  { index: 9,  code: 'C_9',  name: 'Hermit',     cls: 'Discovering', implemented: false },
  { index: 10, code: 'C_10', name: 'Wheel',      cls: 'Cycling',     implemented: false },
  { index: 11, code: 'C_11', name: 'Justice',    cls: 'Weighing',    implemented: false },
  { index: 12, code: 'C_12', name: 'Hanged Man', cls: 'Re-seeing',   implemented: false },
  { index: 13, code: 'C_13', name: 'Death',      cls: 'Ending',      implemented: false },
  { index: 14, code: 'C_14', name: 'Temperance', cls: 'Balancing',   implemented: false },
  { index: 15, code: 'C_15', name: 'Devil',      cls: 'Exposing',    implemented: false },
  { index: 16, code: 'C_16', name: 'Tower',      cls: 'Responding',  implemented: false },
  { index: 17, code: 'C_17', name: 'Star',       cls: 'Meaning',     implemented: false },
  { index: 18, code: 'C_18', name: 'Moon',       cls: 'Verifying',   implemented: true },
  { index: 19, code: 'C_19', name: 'Sun',        cls: 'Celebrating', implemented: false },
  { index: 20, code: 'C_20', name: 'Judgement',  cls: 'Reckoning',   implemented: false },
  { index: 21, code: 'C_21', name: 'World',      cls: 'Integrating', implemented: false },
];

export const CALIBRATION_VERSION = 'v1' as const;

// Phase-1 simplification of `Delta C_i(a) = Match_i × Outcome × Verification ×
// Calibration_i` with Calibration_i = 1 and Outcome/Verification ∈ {0,1}:
// an accepted contribution's dimension tally grows by its match weight.
export function dimensionDeltaFor(dimIndex: number, match: number): number {
  return match;
}

export function isValidDims(dims: unknown): dims is Record<string, number> {
  if (!dims || typeof dims !== 'object' || Array.isArray(dims)) return false;
  const entries = Object.entries(dims as Record<string, unknown>);
  if (entries.length === 0 || entries.length > DIMENSION_COUNT) return false;
  return entries.every(([key, value]) => {
    const index = Number(key);
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < DIMENSION_COUNT &&
      String(index) === String(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 1
    );
  });
}

export function paymentFor(dimIndex: number, match: number): number {
  if (dimIndex === 1) return RES_CONFIG.buildingBounty * match;
  if (dimIndex === 2) return RES_CONFIG.recordingBaseCredit * match;
  return 0; // C_18 pays the verifier per completed check, not the submitter
}

// --- Evidence references (content lives out-of-band; CRABS holds pointers) ---

export interface EvidenceRef {
  hash: string; // sha-256 hex of the content OR of the pointer text
  uri: string;  // 'content://{hash}' for stored objects, otherwise a pointer (URL, id, …)
  mediaType: string;
  size: number; // bytes (0 allowed for pure pointers)
}

export const CONTENT_LIMITS = {
  maxObjectBytes: 8 * 1024 * 1024,
  maxInlineEvidenceChars: 2000,
} as const;

const HASH_RE = /^[0-9a-f]{64}$/;

export function validateEvidenceRef(ref: unknown): ref is EvidenceRef {
  if (!ref || typeof ref !== 'object') return false;
  const r = ref as Partial<EvidenceRef>;
  return (
    typeof r.hash === 'string' && HASH_RE.test(r.hash) &&
    typeof r.uri === 'string' && r.uri !== '' && r.uri.length <= CONTENT_LIMITS.maxInlineEvidenceChars &&
    typeof r.mediaType === 'string' && r.mediaType !== '' && r.mediaType.length <= 64 &&
    typeof r.size === 'number' && Number.isInteger(r.size) && r.size >= 0
  );
}

// --- Step schemas (static code on every replica — handlers consult these) ---

export type StepActor = 'submitter' | 'verifier' | 'custodian' | 'member';
export type PayRule = 'per-dims' | 'per-check' | 'flat';
export type RequirementMode = 'single' | 'all-parties' | 'majority';

export interface StepDef {
  stepId: string;
  title: string;
  requirement: { mode: RequirementMode; count: number };
  actors: StepActor[];
  op: 'submit_contribution' | 'verify_contribution' | 'settle_contribution';
  pays?: Array<{ who: 'submitter' | 'actor'; rule: PayRule; amount?: number }>;
  antiGaming?: Array<'no-self' | 'written-reason' | 'both-parties'>;
}

export interface DimensionSchema {
  dimIndex: number;      // -1 = default schema for unwired dimensions
  schemaVersion: string;
  steps: StepDef[];
}

// Contribution status register values.
export const STATUS_PENDING = 0 as const;
export const STATUS_ACCEPTED = 1 as const;
export const STATUS_REJECTED = 2 as const;
export const STATUS_APPEALED = 3 as const; // set by appeal_verdict; verify accepts 3 like 0

export const SCHEMA_VERSION = 'v2' as const;

// Known schema versions (unknown → wizardModel renders read-only). The number
// is the version's publication order — v2 supersedes v1.
export const SCHEMA_VERSION_NUMBERS = new Map<string, number>([
  ['v1', 1],
  ['v2', 2],
]);
export function KNOWN_SCHEMA_VERSIONS(version: string): boolean {
  return SCHEMA_VERSION_NUMBERS.has(version);
}

const SUBMIT_STEP: StepDef = Object.freeze({
  stepId: 'submit',
  title: 'Submission',
  requirement: { mode: 'single', count: 1 },
  actors: ['submitter'],
  op: 'submit_contribution',
}) as StepDef;

const VERIFY_STEP: StepDef = Object.freeze({
  stepId: 'verify',
  title: 'Verification',
  requirement: { mode: 'single', count: 1 },
  actors: ['verifier'],
  op: 'verify_contribution',
  pays: [
    { who: 'actor', rule: 'per-check' },     // C_18 Moon: per completed check, either direction
    { who: 'submitter', rule: 'per-dims' },  // class-specific outcome bounties on acceptance
  ],
  antiGaming: ['no-self', 'written-reason'],
}) as StepDef;

const SETTLE_STEP: StepDef = Object.freeze({
  stepId: 'settle',
  title: 'Settlement',
  requirement: { mode: 'single', count: 1 },
  actors: ['submitter'],
  op: 'settle_contribution',
  antiGaming: ['written-reason'],
}) as StepDef;

// v2's heavier C_1 verification: two distinct verifiers, all-parties.
const C1_VERIFY_V2: StepDef = {
  ...VERIFY_STEP,
  requirement: { mode: 'all-parties', count: 2 },
};

// Legacy v1 schemas (single-verify everywhere) — kept so contributions
// submitted before v2 keep verifying under the rules they were submitted under.
const LEGACY_DEFAULT_SCHEMA: DimensionSchema = {
  dimIndex: -1,
  schemaVersion: 'v1',
  steps: [SUBMIT_STEP, VERIFY_STEP],
};
const LEGACY_SCHEMAS: Map<number, DimensionSchema> = new Map();
for (const dimIndex of [1, 2, 18]) {
  LEGACY_SCHEMAS.set(dimIndex, {
    dimIndex,
    schemaVersion: 'v1',
    steps: [SUBMIT_STEP, VERIFY_STEP, SETTLE_STEP],
  });
}

// Current (v2) schemas. Export names kept: SCHEMAS/DEFAULT_SCHEMA point at the
// v2 set, so importers are unchanged.
export const DEFAULT_SCHEMA: DimensionSchema = {
  dimIndex: -1,
  schemaVersion: SCHEMA_VERSION,
  steps: [SUBMIT_STEP, VERIFY_STEP],
};

export const SCHEMAS: Map<number, DimensionSchema> = new Map();
for (const dimIndex of [1, 2, 18]) {
  SCHEMAS.set(dimIndex, {
    dimIndex,
    schemaVersion: SCHEMA_VERSION,
    steps: [SUBMIT_STEP, dimIndex === 1 ? C1_VERIFY_V2 : VERIFY_STEP, SETTLE_STEP],
  });
}

export function schemaForDims(dims: Record<string, number>): DimensionSchema {
  const wired = Object.keys(dims)
    .map(Number)
    .filter((i) => SCHEMAS.has(i))
    .sort((a, b) => a - b);
  return wired.length > 0 ? SCHEMAS.get(wired[0])! : DEFAULT_SCHEMA;
}

// Resolve the schema a RECORD was submitted under: version + dims. Unknown
// versions throw — callers validate with KNOWN_SCHEMA_VERSIONS first; the
// wizard's read-only gate uses the version-known check, not the throw.
export function schemaForRecord(schemaVersion: string, dims: Record<string, number>): DimensionSchema {
  if (!KNOWN_SCHEMA_VERSIONS(schemaVersion)) {
    throw new Error(`unknown schema version: ${schemaVersion}`);
  }
  const map = schemaVersion === 'v1' ? LEGACY_SCHEMAS : SCHEMAS;
  const fallback = schemaVersion === 'v1' ? LEGACY_DEFAULT_SCHEMA : DEFAULT_SCHEMA;
  const wired = Object.keys(dims)
    .map(Number)
    .filter((i) => map.has(i))
    .sort((a, b) => a - b);
  return wired.length > 0 ? map.get(wired[0])! : fallback;
}

// Payment helper: who receives what when a verify step completes.
// - 'per-check' pays the actor on EVERY completion of the check (C_18: pays either direction; callers apply it per completion).
// - 'per-dims'/'flat' amounts are emitted once and applied by the caller at the
//   step's final requirement completion.
export function stepPaymentsFor(
  step: StepDef,
  dims: Record<string, number>,
  parties: { actor: string; submitter: string }
): Map<string, number> {
  const out = new Map<string, number>();
  for (const pay of step.pays ?? []) {
    const target = pay.who === 'actor' ? parties.actor : parties.submitter;
    let amount = 0;
    if (pay.rule === 'per-check') {
      amount = pay.amount ?? RES_CONFIG.verificationCheckCredit;
    } else if (pay.rule === 'per-dims') {
      for (const [dimKey, match] of Object.entries(dims)) {
        amount += paymentFor(Number(dimKey), match);
      }
    } else {
      amount = pay.amount ?? 0;
    }
    out.set(target, (out.get(target) ?? 0) + amount);
  }
  return out;
}
