# RCT Recipient + Claimable Types (Slice #6b) — Design Spec

Date: 2026-11-02 · Status: ruled in review of #6a (Victor) · Small protocol + picker slice.

## Problem (two #6a open calls, ruled)

1. **C_18 appeared in the picker uninvited.** Embedded rules (dims whose work is "only defined by
   the workflows of other contributions" — C_18's verifying) must not surface as contribution
   TYPES until properly designed. The derivation from `implemented` alone is wrong.
2. **RCT attribution bug**: a claim whose work belongs to someone else credited the FILING
   member's RCT when the round published, while the tally credit went to the RECIPIENT. Wrong.

**The settled concept (Victor's words):** the system has RCT contribution tokens: they define
VOTING POWER and go to the RECIPIENT of the work — not the submitter — UNLESS the claim is
self-proclaimed (the common case: submit your own work), which is fine when third parties
verify it. So the recipient rule is GENERAL: attribute to whoever's work is attested.

## Decisions

1. **`DimensionDef` gains `pickable: boolean`** — the submittable-as-own-claim flag. C_1, C_2,
   C_19 → `true`; everything else (incl. C_18) → `false`. The picker derives
   `implemented ∧ SCHEMAS.has ∧ pickable` — C_18 leaves the menu without special-casing, and
   future claim dims enter by declaring themselves pickable (no hardcoded lists, ever).
2. **RCT entries attribute to the RECIPIENT**: the `complete_round` payload's entries gain
   `recipient?: string` (assembled client-side = the entry's rec-to-recognized tie when set,
   else the submitter); the aggregation (roundRctTotals call in the handler) attributes the
   entry's weighted amount to `recipient ?? submitter` — machine-validated: when the entry
   carries a recipient, the complete_round handler cross-checks
   `state.setContains(CONTRIB_NAMES.recognized(entry.contributionId), entry.recipient)` → else
   -1 (the claim's stamps are the authority; a forged recipient kills the whole publish op —
   loud, retriable, no partial state).
3. **The documented rule** ("RCT goes to the recipient; self-claims verified by third parties
   suffice") goes in shared/src/round.ts's aggregation comment — the concept's home.
4. The dimension TALLY credit side is ALREADY recipient-correct (the C_19 credit writes the
   recognized member) — no change; only the round aggregation had the wrong attribution.

## Architecture

- `shared/src/contribution.ts`: DimensionDef.pickable (defaults false? — explicit per-dim
  flags: 1/2/19 true, others false; the existing entries grow the field), the SCHEMAS wiring
  untouched.
- `shared/src/round.ts`: the aggregation's entry type gains `recipient?: string`; the totals
  key off it (a 1-line key change + validation note).
- `shared/src/handlers.ts` (complete_round): the recipient cross-check gate.
- `client/src/stores/dao.ts` completeRound: entries gain `...(entry.recognized ? { recipient: entry.recognized } : {})` — read the current entry assembly (it maps dims/harm from the mirror).
- `client/src/wizard/flows/contribute-flows.ts`: the picker's filter adds `.pickable`.
- Tests: the picker derivation (C_18 absent, C_19 present), the aggregation attribution
  (self-claim unchanged numbers; recipient claim → RCT to the recognized member; forged
  recipient → -1).

## Testing

- TDD: the round suite (attribution + the forge gate) + the steps/factory suite (picker).
- e2e: NO new numbers shift (cycle-1's entry is self-claimed: submitter === recipient); the
  recognition arc can assert the ROUND-2 publish... the arc's claim lands in round 2 and the
  e2e doesn't publish round 2 — leave the assert as the tally pin (already exact).

## Aftermath

- Unpushed commits accumulate; push on Victor's word (per the 2026-11-02 ruling on the #6a
  batch — pending).
