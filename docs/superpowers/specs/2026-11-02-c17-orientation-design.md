# C_17 Star — Orientation Credit (Slice #6d) — Design Spec + Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Status: approved in brainstorm (2026-11-02, the /custodians surface).

## Design (spec)

- **`declare_orientation` op** (guide-signed, payload `{orientee: string}`): both members,
  ≠ self, and the FIRST orientation wins — a per-orientee once-REGISTER
  (`CTIZ_NAMES?` → `CONTRIB_NAMES.oriented(orientee)` numeric 0→1; a second declare → -1);
  the guide's name stamped into `CONTRIB_NAMES.orientedBy(orientee)` OR-set (the registry).
  Policy: role:member OR role:custodian (paired setPolicy lines, both nodes).
- **`CONTRIB_NAMES.firstProven(member)`** per-member register — stamped on the member's FIRST
  completed verify step (the verify handler's tally moment: register unset → this verification
  completion is their first proven work). The first-check flag drives the C_17 hook.
- **The C_17 hook** (verify handler, after the tally/credit writes): if the submitter carries an
  orientation (setContains(orientedBy(submitter), X) is UNREADABLE handler-side — RESOLUTION B
  as in #6a/#4c: the guide name RIDES the verify op's payload `orientedBy?: string`, cross-checked
  `state.setContains(CONTRIB_NAMES.orientedBy(payload.submitter), payload.orientedBy)` → else -1
  (forgery dies); and when `payload.orientedBy` is absent → no hook) AND the first-proven
  register is unset → the GUIDE's C_17 tally credits (match × alphaFor(17) × 1) + stamp
  firstProven. The recognized/tie pattern VERBATIM.
- **The client**: the dao mirror gains `entry.orientedBy?`?? NO — orientation is MEMBER-level,
  not per-contribution: the dao gains `getOrientationGuide(orientee): string | null` (member-scan
  setContains); the store's verify flow carries `orientedBy` when the submitter is oriented AND
  firstProven unset (accessor `isFirstProven(member): boolean`); the mirror stamps nothing new.
- **The surface** (/custodians): an "Orientation" panel with a mini flow (members pick count 1,
  options = members minus self minus already-oriented (the accessor reads the once-register per
  candidate), review) → `ds.declareOrientation(orientee)` (boolean contract). Custodians page
  placement per the approved design; the panel hides its flow when the viewer has no eligible
  orientees (the visible dead-end standard).
- **Feed row**: `declare_orientation` joins CONSEQUENTIAL_OPS ("X runs orientation for Y" —
  the orient declaration IS the onboarding trail's visible event per the BPMN's
  "Share entry progress with the Fool").


