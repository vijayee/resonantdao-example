# C_17 Star — Orientation Credit (Slice #6d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: docs/superpowers/specs/2026-11-02-c17-orientation-design.md

---

## **Task 1 — protocol (TDD)**: the op + registers + the verify hook. Failing contracts:
O-A happy declare → 0 + registry + once stamped; O-B second orientation of the same orientee → -1; O-C self/non-member → -1; O-D policy (setPolicy both nodes — the #4c lesson: jest mocks don't enforce; the e2e would catch); V-A the hook credits the guide (match × alpha(17), default arc; seeded-arc scaled) at the orientee's FIRST verify; V-B the SECOND verify of the same member credits NO C_17 (the once-register); V-C forge: `orientedBy` payload name ≠ registry stamps → -1; V-D no registry → no hook (untouched).
Commit: `feat(state): orientation declared first-wins; the guide's C_17 credit rides first proven work (TDD)`.

**Task 2 — client + wizard (TDD for the accessor where pure; typecheck the panel)**: the dao
accessors (`getOrientationGuide`, `isFirstProven`, `eligibleOrientees`), the store op
(`declareOrientation`: boolean contract), the /custodians Orientation panel (the hosts'
conventions: in-place, :key'd, page-level gating). Commit: `feat(custodians): the orientation panel — the guide declares; the star waits for first proven work`.

**Task 3 — e2e arc**: alice orients bob via /custodians → bob's first verify → alice's C_17
tally pinned EXACT (`C_17 Star — 1`, element-scoped); attendance-only pays nothing (the
declare alone leaves the tallies untouched); the second verify adds no C_17. Commit:
`test(e2e): the orientation arc — declared first-wins, credited on first proven work`.

**Task 4 — verification + the de-wonk close** (the standing recipe; the audit runs LAST per
the decree; its verdict + any fixes close the slice).

## Testing

- jest at every seam (the orientation suite's contracts above); e2e the arc; gates as usual.
