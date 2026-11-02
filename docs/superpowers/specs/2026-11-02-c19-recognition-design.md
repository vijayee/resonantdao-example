# C_19 Sun — Public Recognition (Slice #6a) — Design Spec

Date: 2026-11-02 · Status: approved in brainstorm · Builds on: the 22-dimension campaigns
plan-of-record (the Sept BPMN designs: docs/contribution-economy/bpmn/c19-sun.bpmn), the wizard
substrate (#4b/#4c), the owner/verifier state rules (#4c).

## Problem

The dimension campaign's first slice: the designed-dim taxonomy (2026-11-02) sorts the 22 into
claim-types / spine-embedded / lifecycle-embedded / upstream-fed. C_19 is the only new
CLAIM-TYPE among the five designed dims: public recognition submitted as a contribution with a
machine-checked tie to a verified record ("popularity alone pays nothing").

## Decisions

1. **C_19 is a submittable contribution type** — schema
   `[submit → verify(single, targeted) → settle]`, `implemented: true`, wired into `SCHEMAS`.
2. **The claim payload** (RecognitionPayload): `contributionId`, `dims {19:1}`, `summary`,
   `evidenceRef` (as every claim), plus the two ties: `recognized: string` (the member whose
   work is recognized — ≠ the submitter, a member) and `recordId: string` (the contribution
   whose proven work is recognized). Validation mirrors every claim's plus: recognized is a
   member; recordId is an EXISTING contribution (membership set).
3. **The dimension gate (THE substrate generalization)**: the VERIFY handler, for
   contributions carrying a dim whose gate exists, runs the dim's predicate before recording a
   pass — for C_19: `recordId` must exist AND its status register must be ACCEPTED; a pass
   against a missing/unsigned/unaccepted record → -1 (the "reviewer checks the record" BPMN
   gate, machine-enforced). Failures of the GATE reject the op — the wizard shows the reason.
4. **Credit — THE CONTRIBUTION TOKEN, not $RES** (Victor, 2026-11-02): the RECOGNIZED member is
   the credited party (recognition is of their proven work); the credit increments their C_19
   DIMENSION TALLY by the match weight (`dimensionDeltaFor(19, match)` — the standing phase-1
   delta rule; matches every BPMN's "tally updated"), written at final verify alongside the
   existing tally-write pattern. NO $RES moves (recognition pays in reputation-weight, not
   money). The recognized member rides the flow as a subject (no turn); tallies + feed pick the
   credit up automatically; the LEDGER shows no line (it is an earned-MONEY story).
5. **Reviewer pick**: single targeted verifier via the #4c members step (screened as always —
   note: the recognizer may name any eligible member INCLUDING the recognized one? The
   recognized member reviewing their own recognition is odd but not barred — the domain rule
   says only the tie matters; ALLOW it (the machine gate is the tie; social choice is the
   picker's business).
6. **The picker derives from `DIMENSIONS.filter(d => d.implemented)` joined with the SCHEMAS
   map** — C_19 auto-appears; the hardcoded `['2','1']` picker item dies with this slice.

## Architecture

- `shared/src/contribution.ts`: RES entry + the C_19 v2 schema (verify single/all-parties per
  the Sept design: ONE reviewer) + RecognitionPayload type; the recognized/record registers
  (`CONTRIB_NAMES.recognized(id)`, `CONTRIB_NAMES.recordTie(id)`) — submit stamps them so the
  verify gate + projections read registers.
- `shared/src/handlers.ts`: submit handler validates the C_19 payload shape + stamps the
  registers (dims carry the dim: gates key off `dims`); VERIFY handler gains the dim-gate hook —
  BEFORE the pass records, for each wired dim in the payload's dims with a gate: run the
  predicate (C_19's = record exists && status accepted); settle unchanged (shape parity).
- Tally at final verify: recognition credits the RECOGNIZED member's C_19 dimension tally (the
  contribution token — no $RES movement; a new tally branch keyed on the dim in the handler's
  verify hook).
- Wizard: the contributeNewFlow's dim step gains desc copy for C_19; the CLAIM steps gain two
  text-like pickers (recognized member picker reusing the 'members' kind with count 1 — the
  screen: non-self members; the recordId — a NEW step kind? The record link: a picker of the
  viewer's OWN ACCEPTED contributions (small enumerated options list, count 1) — reuse the
  'members' kind with the accepted-record ids as options! No new kind — the factory supplies
  options; the review shows the three lines).
- Lifecycle waiting text: the verify gate's failure surfaces via the flow's error path — the
  recognizer's fix is cancel/renotify; nothing new.
- Feed row: the settle/verify cases cover it; the builder's submit case gains the recognized
  tie in its summary? The existing submit summary is summary-based — add the tie as detail
  (LOW, optional).

## Testing

- TDD: the gate contracts (tie unaccepted/missing → reject; self-recognition → -1; happy path:
  recognized member's C_19 tally increments at final verify) in a
  `server/test/c19-recognition.test.ts` suite (MockNode/MockState fixture pattern); wizard
  picker derivation tests in the steps suite.
- e2e: the recognition arc — alice recognizes bob's accepted record → names dave the reviewer →
  dave confirms → bob's C_19 tally shows the increment (no ledger line — it's a tally, not
  money); gates as usual.

## Amends

- The hardcoded picker list dies (derivation rule); RES_CONFIG gains the entry; the #4c LOW
  note resolves.
