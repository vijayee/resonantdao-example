# C_5 Hierophant — Teaching Claim (Slice #6e) — Design Spec

Date: 2026-11-06 · Status: approved in brainstorm (the batch ruling + "yes") · The third
claim-type; the C_19 machinery's generalization to its first other-shape.

## Problem

The generic-schema batch's first member: C_5 (Teaching) — "credited on demonstrated competence
in ANOTHER member." The claim machinery (targeted reviewer pick, tie gates, the
weight-scaled tally) is proven; this slice wires the shape's first real variation — the tie
points at the TAUGHT member's work, machine-pinned via the OWNER set.

## Decisions

1. **C_5 is a submittable claim** — schema `[submit → verify(single, targeted) → settle]`,
   `implemented: true`, **`pickable: true`**.
2. **The claim payload** (extends the claim fields): `taught: string` (the member whose
   competence is demonstrated — ≠ the filer, a member) + `recordId: string` — **and the tie
   rule sharpens**: the linked record must be ACCEPTED **AND authored by the TAUGHT member** —
   machine-checked via the owner set
   (`setContains(CONTRIB_NAMES.owner(payload.recordId), payload.taught)`): the demonstration's
   proven work belongs to the student. That's the #4c owner set paying for itself.
3. **The verify gate**: the C_19 pattern generalized — the verify op re-carries
   `taught`/`recordId`, all pinned against the claim's stamps (taught set + recordTie set),
   and the tie-real predicates run per-dim: C_19 = record accepted; C_5 = record accepted ∧
   record's owner === taught. The per-dim predicates become an explicit map in the handler
   (the gate hook's structural home) — the substrate's claim-gate seam, now two shapes wide.
4. **The credit**: the FILER's C_5 tally (the teacher's demonstrated-teaching dimension; a
   self-claim of their own teaching, third-party verified — the honest recipient), match ×
   alphaFor(5) × harm-factor at final verify. NO $RES movement (consistent with C_19; money
   stays tied to building/recording; flag to veto if the teaching should carry a bounty).
5. **The claim flow** (dynamic steps): after the type pick — taught pick (members, count 1,
   non-self members), record pick (members-kind count 1, options = accepted contributions
   WHOSE SUBMITTER is the chosen taught member — options DYNAMIC per the taught answer),
   reviewer pick, summary, evidence, review; the review line shows both ties with the record's
   summary mapped.
6. **The aggregation recipient**: C_5 claims' RCT (the round aggregation) — recipient = the
   filer (their tally; the recipient rule covers self-claims when third parties verify —
   the concept comment's degenerate case). No new rule text needed.
7. Picker copy: C_5 gains its selling line in DIM_DESCS ("taught something real — credited on
   the student's demonstrated competence").

## Architecture

- `shared/src/contribution.ts`: the implemented/pickable flags + the C_5 v2 schema entry (the
  SCHEMAS loop gains 5 — single verify).
- `shared/src/types.ts`: the claim fields extend (the optional-fields pattern): `taught?` rides
  the submit + verify payload types.
- `shared/src/policies.ts`: `CONTRIB_NAMES.taught(id)` (OR-set, the recognized pattern).
- `shared/src/handlers.ts`: the submit handler's per-dim claim handling generalizes (a small
  per-dim claim-validation/stamp hook; C_19's block refactors INTO the hook — behavior
  identical); the verify handler's per-dim GATE map (C_19's gate + C_5's gate); the tally credit
  at the isFinal completion: the C_5 branch = the FILER's tally (match × alphaFor(5) × harm).
- Client: the mirror gains `entry.taught?`; the verify spread carries taught/recordId for C_5;
  the claim flow's dynamic record-pick options (the taught member's accepted records); the
  picker's DIM_DESCS entry.
- Feed: no change (the submit/verify/settle rows cover it; the tie detail was pinned LOW in the
  #6a aftermath — leave unless Victor wants it).

## Testing

- TDD: the new suite's shape rides `c19-recognition.test.ts` — new contracts: W (the schema
  wiring), S (the claim stamps + taught validation + self-taught -1 + the tie-owner mismatch
  -1), G (the gate: non-accepted tie → -1; tie owned by ANOTHER member → -1; the happy arc →
  the FILer's C_5 tally pinned (match × alpha default); the forged re-carry pin), the picker
  derivation (C_5 in, C_1/C_2/C_19 in, C_18 out).
- e2e: the teaching arc (alice teaches: names bob, ties bob's accepted record → dave verifies →
  alice's C_5 tally pinned `C_5 Teaching — 1`-shaped chip) — placed after the recognition arc.

## Aftermath

- The claim-gate map is the substrate seam — the next claim-types (C_15's corroboration etc.)
  design onto it, not around it.
