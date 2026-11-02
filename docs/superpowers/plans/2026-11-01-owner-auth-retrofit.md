# Owner Authentication Retrofit (Settle & Appeal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both settlement-side handlers (settle_contribution, appeal_verdict) authenticate the
actor against the machine-recorded owner set, closing the forgeable payload-claim gap.

**Architecture:** The `CONTRIB_NAMES.owner` OR-set (landed in slice #4c) is the authority; each
handler gains the setContains gate beside its payload-claim check; the payload-claim check
stays. Tests in the targeted-verification suite; no client changes.

**Tech Stack:** shared TS + jest (TDD).

Spec: `docs/superpowers/specs/2026-11-01-owner-auth-retrofit-design.md`

---

## Task 1: the two gates (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (makeSettleContributionHandler + makeAppealVerdictHandler)
- Test: `server/test/targeted-verification.test.ts`

- [ ] **Step 1: failing tests** (append to the targeted suite, its fixture idioms):

```ts
// Contract:
// Q. settle by the TRUE owner (alice on alice's submission) → 0 (unchanged).
// R. settle FORGED: bob submits settle_contribution with payload.submitter =
//    'bob' on ALICE's contribution (verify complete, untargeted legacy shape
//    is fine — the gate is unconditional) → -1. The payload-claim pattern
//    passed this before; the owner set is what now refuses it.
// S. appeal forged the same way (payload.submitter = 'bob', alice's rejected
//    contribution) → -1.
// T. appeal by the true owner after a rejection → still 0 (the legal arc).
```

- [ ] **Step 2: run to FAIL** — `npx jest server/test/targeted-verification.test.ts --runInBand` → R and S fail (the handlers admit the forged ops today).

- [ ] **Step 3: implement** — in BOTH `makeSettleContributionHandler` and `makeAppealVerdictHandler`, immediately AFTER the existing `payload.submitter !== op.signerId` check:

```ts
    // Ownership is machine state, not the payload claim (slice #4c's flag):
    // the owner set records the TRUE submitter at submit time.
    try { node.addORSet(CONTRIB_NAMES.owner(payload.contributionId)); } catch (err) { /* replay idempotence */ }
    if (!state.setContains(CONTRIB_NAMES.owner(payload.contributionId), op.signerId)) {
      return -1;
    }
```

(check each handler's `node` param declares OR-sets — both do; the defensive declare is the
replay-idempotence idiom used by the reassign/verify gates.)

- [ ] **Step 4: PASS** — targeted suite green (Q-T); full `npm test` → all suites green (pre-existing settle/appeal suites: their fixtures submit through the handler first — owner stamped — so they stay green).

- [ ] **Step 5: commit**

```bash
git add shared/src/handlers.ts server/test/targeted-verification.test.ts
git commit -m "feat(state): settle and appeal authenticate against the machine-recorded owner"
```

---

## Task 2: verification

**Files:** none expected.

- [ ] **Step 1:** `npm test` → all green (16 suites).
- [ ] **Step 2:** `npm run typecheck:client` → 0 (client untouched; sanity only).
- [ ] **Step 3:** main e2e + feed walk on fresh DBs per the standing recipe (the arcs act as
  true submitters — pass through the gates) + the usual gates (typecheck, build, devtools,
  dialog grep). Dev-server stop/restart per convention (stop first, restart at the end).

Failures: test fixtures are in scope to fix; shared bugs → BLOCKED with output.

---

## Self-review notes

- Spec coverage: the retrofit gate pair (Task 1), legacy caveat (the gate's behavior IS the
  caveat — documented + the pre-owner-set rejection is Q's negative space), client untouched ✓.
- Type consistency: the gates are verbatim copies of the verified reassign gate.