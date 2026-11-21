# C_15 Devil — Corroborated Exposure (Slice #6f) — Design Spec + Plan

Date: 2026-11-09 · Status: ruled in the campaign directive ("continue developing the rest") ·
The claim-family's third gate shape: corroboration + the penalty gateway.

## Design (spec)

- **C_15 is a submittable claim** — schema `[submit → verify(TWO corroborators, all-parties) →
  settle]`, `implemented: true`, `pickable: true`. The two named corroborators = the existing
  all-parties count-2 machinery (C_1 v2's exact verify shape).
- **The claim**: dims `{15:1}`, summary + evidence as every claim. NO extra ties (the
  corroboration IS the gate — two independent reviewers must uphold the exposure).
- **The verify gate**: the standard corroborated pass (no tie predicate; corroboration = both
  named members' Uphold). The re-carry pins: none needed (no tie fields) — the targeted set
  carries it.
- **THE PENALTY GATEWAY**: when a C_15 claim's verification completes with a REJECT (the
  corroborators or the step resolve the claim as unproven), the FILER pays the **C_15 tally
  penalty**: their C_15 tally decrements by `match × alphaFor(15)` (the symmetric negative of
  the reward — false exposures cost exactly what true ones earn). $RES untouched (credibility
  penalty only). Machine rule text: "exposing validated distortion earns among the largest;
  false exposures pay the same, negative."
- **The credit**: the FILER's C_15 tally `+match × alphaFor(15) × harm` at final verify — the
  tally-credit idiom, keyed dim 15.
- **Picker**: C_5/C_19-style selling line ("expose a skewed incentive — two corroborators, and
  false exposures cost the same weight").

## Plan (tasks)

**Task 1 — protocol (TDD)**: flags + the SCHEMAS 15 entry (all-parties count 2 verify: reuse
`C1_VERIFY_V2`-shaped C_15_VERIFY); the verify handler's dim-15 branches (credit on pass; the
penalty on final REJECT — the isFinal reject path exists for step resolution; the negative
delta writes via the same per-mille accumulate). Contracts: F-A the happy arc → the filer's
C_15 tally +match (both corroborators, default + seeded alpha arcs); F-B the final REJECT arc →
−match (the filer's tally goes negative, per-mille accumulate); F-C a HALF-corroborated claim
(only 1 of 2 upholds → the step not final → no credit/penalty yet); F-D $RES invariant; F-E the
re-carry pins (no taught/recognized on a 15 claim — the targeted set carries the corroborators;
the gate rejects a 15 pass from an unnamed party — the #4c rule rides).
Commit: `feat(state): C_15 Devil — corroborated exposures with the symmetric penalty (TDD)`.

**Task 2 — client/flow**: the mirror's tie-free pass-through (nothing extra), the claim flow's
corroborator pick (members count 2), DIM_DESCS 15. Commit:
`feat(contribute): the exposure claim — two corroborators named up front`.

**Task 3 — e2e**: the exposure arc (alice files, names bob+carol; both uphold → alice's C_15
chip +1) + the penalty arc (eve files, names bob+carol; they reject → eve's C_15 chip −1).
Commit: `test(e2e): the exposure arcs — corroborated credit, symmetric penalty`.

**Task 4 — verification + the de-wonk close** (the standing recipe; the audit LAST per the
decree).
