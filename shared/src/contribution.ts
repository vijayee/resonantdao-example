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