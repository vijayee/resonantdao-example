# Harm Adjustments (Delta Formula's Verification Term) — Design

Date: 2026-10-09
Status: approved design, pending implementation plan
Depends on: phases 1-3 + wasm-drift fix (all implemented)
Source of truth: https://resonantdao.com/contribution-economy/ (verified verbatim 2026-10-06): "*verified harm reduces/voids the outcome beforehand*"; delta formula `Delta C_i(a) = Match_i × Outcome × Verification × Calibration_i` with harm reducing/voiding before payment.

## Purpose

Implement the delta formula's last missing term: verified harm shrinks or voids a contribution's payment and tally deltas **before they apply** (page semantics; also the only direction our architecture can express — balances never go below zero, so retroactive clawback is inexpressible and deliberately out of scope).

## Decision (locked 2026-10-09)

**Design A — harm rides in the verify verdict; fixed pilot factor 0.5.** No new ops, no new registers; one payload field + one constant + handler math + aggregation mirroring + UI.

## Data model

- `VerifyContributionPayload` gains `harm?: 'none' | 'reduced' | 'voided'` — absent → 'none'; validated ∈ the three values.
- `RoundEntry` gains `harm?: 'none' | 'reduced' | 'voided'` (payload-attested through `complete_round`, same PoC trust class as dims/submitter — the mirror knows the settled verdict).
- Pilot constant `HARM_REDUCE_FACTOR = 0.5` + helper `harmFactorFor(harm|undefined): number` (none/undefined → 1; reduced → 0.5; voided → 0) in `shared/src/contribution.ts`. Fixed, not custodian-tunable (YAGNI; the alpha pattern exists if ever needed).
- No new registers, no new CRABS holdings; harm's durable trace = the verify explanation record + the already-adjusted balances.

## Handler semantics (shared/src/handlers.ts)

- **verify_contribution**, in the payment/tally block (after all existing validation incl. reciprocity):
  - submitter bounty: `amount × harmFactorFor(payload.harm)`;
  - per-dimension delta: `dimensionDeltaFor(i, match) × harmFactorFor(payload.harm)`;
  - the **verifier's per-check credit is NOT adjusted** (the verification itself happened — page's per-check either-direction rule stands);
  - voided (factor 0): status still becomes accepted at the final requirement (the work was real), zero RES and zero tally; the explanation record's `payments`/delta reflect 0 and carry `harm: 'voided'` — the receipt visibly shows the void (spec's explanation-record invariant working as designed).
- **Two-verifier C_1 (all-parties):** the conservative rule is strongest-wins: voided > reduced > none. The completing verify's payload carries its own `harm` plus an optional `priorHarm?: 'none' | 'reduced' | 'voided'` (client-attested verdict of the earlier check in this step, fed from the mirror); the handler computes the effective verdict as `strongest(priorHarm, harm)` and applies that factor — deterministic, from payload bytes only.

## Aggregation consistency (complete_round)

- The phase-2 aggregation recomputes totals from raw entry dims — harm must mirror the verify handler or published RCT diverges from adjusted tallies. `complete_round`'s totals: `Σ alpha_i × match × harmFactorFor(entry.harm)`. Entries validation: `entry.harm` must be one of the three values (undefined → 'none'); the UI's entry collection passes the settled contribution's verdict through.

## Explanation records

- Verify explanation record gains `harm` (the effective verdict) and the already-multiplied payments — receipts reproducible downstream.
- Publish record unchanged in shape; totals already carry harm.

## UI (client)

- Verify dialog: three-choice flow — accept / accept-with-harm (sub-choice: reduced or voided) / reject — reason still required always.
- Cards: accepted-but-adjusted cards show the receipt ("12 → 6 (harm reduced)" style); voided cards show "accepted — outcome voided (harm)".
- complete_round collection passes `harm` from the settled contribution's verdict (mirror-tracked `entry.harm` — verify-branch sets it).

## Error handling

- Invalid harm string → -1 (op rejected, logged/skipped on replay per convention).
- Harm on appeal re-verification: works orthogonally (appealed contributions re-verify; the fresh verdict's harm applies).
- A harm-reduced-but-accepted contribution CANNOT be appealed (appeals are rejected-only; documented — the page's "measurement failure is the system's debt" path for disputes over harm is deferred to C_11/C_20's real reconciliation).

## Testing

- Unit: `harmFactorFor`, `strongest`, RoundEntry harm validation.
- Handler tests: reduced/voided payment math (res + tallies), verifier credit unadjusted, priorHarm combination, all-parties any-harm-prevails, aggregation mirror (RCT totals × factor; voided entry contributes 0 to RCT).
- Real wasm: harm-adjusted lifecycle through DaoNode (reduced C_1: bob+carol verify with priorHarm; settle; complete_round → RCT = 0.5 × alpha × match).
- Hydration: harm-bearing explanation records + adjusted balances survive replay.
- UI manual (three-choice dialog + receipts) + e2e harm path extension.

## Execution amendment (2026-10-09): per-mille register encoding

Real CRABS registers are integer-only (BigInt backing: `setRegister(0.5)` throws `RangeError`); mocks accept floats — the fractional tally/RCT/RES writes this design produces were never real-wasm-exercised until the harm pin test. The page's spec REQUIRES fractional match weights (worked example: Priestess 0.20, Empress 0.50, Hierophant 0.30), so fractions are not negotiable. **Resolution: per-mille integer encoding — all fractional-bearing registers (RES balances, dimension tallies, published RCT, and — execution finding — `config:alpha:*`, whose validated range includes 0.5) store `Math.round(value × 1000)`; getters, handler-side reads (vote gating's tally and alpha input, aggregation accumulation), and test assertions divide by 1000. Vote base/cap, versions, counters, and status/step/state registers stay unscaled. Deterministic (Math.round on register-derived floats; identical on every replica; accumulations stay in register units to avoid rounding-drift cycles). Vote gating never writes registers — only reads — so comparisons stay JS-float.

- Retroactive-harm adjustment (flag_harm post-acceptance): inexpressible (no negative balances) — the page's pre-payment rule stands.
- Custodian-tunable harm factor: deferred (fixed 0.5 pilot).
- Harm-based penalties on the harmer (C_15 Devil's penalty rails), harm-appeal dispute flow (C_8/C_20), accuracy-vs-chance (C_18 rotation): all deferred.