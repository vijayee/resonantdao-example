# C_7 Chariot — Milestone Claims (Slice #6g) — Design Spec + Plan

Date: 2026-11-09 · Status: ruled in the campaign directive ("continue developing the rest") ·
The claim family rides the gate map; C_7's new shape is a MULTI-MILESTONE schema — and it's
mostly DATA.

## Design (spec)

- **C_7 is a submittable claim** — schema with a SECOND verification step:
  `[submit → verify M1 (single) → verify M2 (single) → settle]` — the step-count machinery
  already walks `schema.steps` progression (the C_1 v2 shape proves multi-step; the settle-then
  -verify gating reads the step register). **This is a data-only schema** — no new machine rules.
- **The claim**: dims `{7:1}`, summary + evidence; targeted single verifier per milestone step
  (the SAME named verifier carries both milestones — the verifiers count derives from the schema's
  FIRST verify step = 1; each milestone check is one op; both checks pay the verifying member
  +2 each per the standing rule).
- **The gate**: milestone N completes only when milestone N−1 has (the step register's own
  ordering — machine-guaranteed already); the two verify steps are plain (no extra tie predicate);
  the claim's per-milestone evidence rides the payload's stepId (the verify payload carries it).
- **Tally credit**: the FILER's C_7 tally gains `match × alphaFor(7) × harm` at EACH final
  milestone completion? NO — the standing rule pays per CONTRIBUTION at the final step; C_7's
  tally credit fires ONCE at the LAST verify (match × alphaFor(7) × harm), the same as every
  claim — the milestones shape the payment's TIMING, not its count.
- **Picker**: C_7's selling line; `pickable: true`; the SCHEMAS loop gains 7.

## Plan (tasks)

**Task 1 — protocol (TDD)**: flags + the SCHEMAS 7 entry (the two-verify-step schema); contracts
in a new c7 suite (or the c19 suite riding): M-A the two-milestone arc (check 1 → the step
register advances to M2's verify; check 2 → isFinal → the filer's C_7 tally × alpha, ONCE) ;
M-B each check pays the verifier +2; M-C the milestones OUT OF ORDER (M2 before M1) → -1 (the
step register gates); M-D the settle path completes; M-E $RES invariant beyond the checks.
Commit: `feat(state): C_7 Chariot — milestone claims walk two verified gates (TDD)`.

**Task 2 — client/flow**: the verifiers pick counts (the schema's first verify = 1); the
lifecycle waiting text for the second milestone (the phases carry two verify phases —
lifecycleModel derives from the schema, data-only — verify rendering handles 2 verify steps);
DIM_DESCS 7. Commit: `feat(contribute): the milestone claim — two gates, one settled whole`.

**Task 3 — e2e**: the arc (alice files C_7, names bob; bob's M1 check → the phase rail advances
to M2; bob's M2 check → settle → alice's C_7 chip exact). Commit:
`test(e2e): the milestone arc — two gates, credited once at the last`.

**Task 4 — verification + the de-wonk close** (the standing recipe; the audit LAST).

## Open call (Victor, veto in review)

The two-milestone schema uses the SAME single named verifier for both gates. The alternative —
a DIFFERENT verifier per milestone — needs per-STEP targeting (a new payload/registry surface);
not built. Say if milestones should re-name verifiers and I'll fold that in as its own slice.
