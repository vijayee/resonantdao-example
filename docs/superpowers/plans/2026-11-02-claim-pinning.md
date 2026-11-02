# Claim Pinning (Fixes 1+2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No owed field may default silently: a 19-dim entry published without a recipient is
rejected; the verify op's `submitter` claim is pinned against the machine's owner stamp. Nothing
unpushed — the whole campaign batch goes together (push on Victor's word at the close).

**Architecture:** Two atomic machine gates, each TDD'd red-first:
(1) complete_round: `entry.dims['19'] ⇒ entry.recipient !== undefined` (a malformed/missing
recipient kills the whole publish — no partial state);
(2) verify: `payload.submitter` claim must satisfy
`state.setContains(CONTRIB_NAMES.owner(payload.contributionId), payload.submitter)` (the stamps
are the referee; the payload-claim pattern dies here).
A de-wonk audit loop caps the slice — no remaining known seams survive it.

Spec inputs: the #6a/#6b reviews' residues (2026-11-02).

---

## Task 1: the two gates (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (both gates)
- Test: `server/test/contribution.test.ts` (the complete_round handler suite) + `server/test/c19-recognition.test.ts` (the verify spread) — read each suite's helpers first

- [ ] **Step 1: failing tests**:
  - PIN-A (complete_round): a 19-dim entry WITHOUT recipient → -1; no partial state (same assertion shape as RCT-C).
  - PIN-B (complete_round): the recipient present + matching stamps → 0; units coherent.
  - PIN-C (verify): a pass whose `submitter` claim is NOT in the owner stamps → -1 → no stepDone credit, no tally movement, no per-check accrual (assert both directions: the true owner's spread passes; a forged spread fails + nothing moved).
  - PIN-D: the LEGACY negative space: an old-shape contribution (non-19, no owner stamped — a destroyed/foreign scenario) → existing behavior unchanged (the spread only applies on 19; the owner gate applies to all verifies — confirm the existing suites' fixtures still pass — they submit first, so owner is set).

- [ ] **Step 2: FAIL → implement** (the gates in their pre-write loops).

- [ ] **Step 3: PASS + full jest + both typechecks.** Commit:
  `fix(state): owed fields pin — recipient required on 19-entries; submitter claims pinned to the owner stamp`

---

## Task 2: verification

**Files:** none expected.

- [ ] **Step 1:** full jest green; both typechecks.
- [ ] **Step 2:** main e2e + feed walk (the standing recipe; WAVEDB_PATH always; never touch ./data).
- [ ] **Step 3:** gates as usual.

Failures: fixtures fixable; shared bugs → BLOCKED with output.

---

## Close-out (controller)

The de-wonk audit loop runs LAST (after Task 2), per the decree: the question is whether anything remains unimplemented/stubbed/disabled/broken/weird; the answer closes the slice. Known seams at audit time: NONE — both fixed here; the C_17 campaign slice (#6c) proceeds after.
