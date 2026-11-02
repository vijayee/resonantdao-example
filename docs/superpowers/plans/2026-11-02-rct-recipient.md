# RCT Recipient + Claimable Types (Slice #6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claims surface only when `pickable`; published rounds attribute RCT to the work's
RECIPIENT (machine-validated against the claim's stamps).

**Architecture:** One flag (`DimensionDef.pickable`, claims 1/2/19) + one attribution rule
(entries gain `recipient?`, the aggregation keys off it, the complete_round handler cross-checks
the recognized stamps). Concept comment in round.ts.

**Tech Stack:** shared TS (jest, TDD), client picker.

Spec: `docs/superpowers/specs/2026-11-02-rct-recipient-design.md`

---

## Task 1: `pickable` + the picker (TDD)

**Files:**
- Modify: `shared/src/contribution.ts` (DimensionDef.pickable: 1/2/19 true, others false)
- Modify: `client/src/wizard/flows/contribute-flows.ts` (the derivation adds `.pickable`)
- Test: `server/test/contribution.test.ts` (the implemented pin extends to pickable) + a picker
  derivation assert where the steps/factory suite fits

- [ ] **Step 1: the failing test** — extend `contribution.test.ts`'s implemented-pin:

```ts
// implemented = submittable machine rules; pickable = surfaces as a claim
// type in the picker. C_18 is implemented (its rule is live) but NOT
// pickable — embedded rules surface through the flows they belong to.
expect([...DIMENSIONS].filter((d) => d.pickable).map((d) => d.index)).toEqual([1, 2, 19]);
```

- [ ] **Step 2: FAIL → implement** — each entry's `pickable` explicit (write it per entry);
  the factory: `DIMENSIONS.filter((d) => d.implemented && SCHEMAS.has(d.index) && d.pickable)`.
  Commit:

```bash
git add shared/src/contribution.ts client/src/wizard/flows/contribute-flows.ts server/test/contribution.test.ts
git commit -m "feat(state): pickable flags the claimable dims — C_18 leaves the picker by rule"
```

---

## Task 2: RCT attribution to the recipient (TDD)

**Files:**
- Modify: `shared/src/round.ts` (the entry type gains `recipient?: string`; roundRctTotals keys
  off it; the concept comment)
- Modify: `shared/src/handlers.ts` (complete_round: the recipient cross-check)
- Modify: `client/src/stores/dao.ts` (completeRound's entry assembly gains recipient)
- Test: `server/test/round.test.ts` (or wherever roundRctTotals' tests live — read first)

- [ ] **Step 1: failing tests**:

```ts
// Contracts:
// RCT-A: self-claimed entries (no recipient) attribute to the submitter —
//        every standing number unchanged.
// RCT-B: an entry with recipient=X attributes X's total — assert the totals
//        map keyed by recipient.
// RCT-C (handler): complete_round with a recipient NOT in the claim's
//        recognized stamps → -1 (the whole op rejected; no partial state).
// RCT-D (handler): recipient matching the stamps → 0; the RCT register
//        balances credit the recognized member.
```

- [ ] **Step 2: FAIL → implement** — roundRctTotals: `const key = entry.recipient ?? entry.submitter;` in the accumulate (round.ts:61-74's actual loop); the concept comment:

```ts
// RCT attribution (Victor, 2026-11-02): RCT is the contribution token — it
// defines VOTING POWER and goes to the RECIPIENT of the work, not the
// filer. Self-proclaimed claims (submit your own work) are the degenerate
// case — recipient = submitter — legitimate because third parties verify.
```

complete_round (handler): after the entries validation, each entry whose `recipient` set:
`if (!state.setContains(CONTRIB_NAMES.recognized(entry.contributionId), entry.recipient)) return -1;`
(declare-first try/catch per idiom — an undeclared set on a self-claim must reject absent
recipients gracefully: only entries CARRYING recipient get the check).

client completeRound: the entry assembly (read it — `entry.harm ?? 'none'` block at stores/dao.ts ~completeRound):

```ts
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter,
          dims: entry.record.dims, harm: entry.harm ?? ('none' as const),
          ...(entry.recognized ? { recipient: entry.recognized } : {}) }));
```

- [ ] **Step 3: PASS + full jest + both typechecks.** Commit:

```bash
git add shared/src/round.ts shared/src/handlers.ts client/src/stores/dao.ts server/test/round.test.ts
git commit -m "feat(state): RCT credits the recipient of the work — attributed, machine-checked"
```

---

## Task 3: verification

**Files:** none expected.

- [ ] **Step 1:** full `npm test` green; both typechecks.
- [ ] **Step 2:** main e2e + feed walk on fresh DBs (`WAVEDB_PATH=/tmp/dao-6b-e2e` etc., the
  standing recipe: stop dev server first by PID chains, restart at the end). NO assert numbers
  shift (all e2e entries are self-claimed).
- [ ] **Step 3:** gates (build, devtools, dialog grep) as usual.

Failures: test fixtures fixable; shared bugs → BLOCKED with output.

---

## Self-review notes

- Spec coverage: pickable (Task 1), recipient attribution + forge gate + concept comment
  (Task 2), verification (Task 3) — all spec decisions 1-4 mapped; the tally side needs
  nothing (already recipient-correct).
- Type consistency: `roundRctTotals(harmAdjusted, alphaFor)` — the entry type's growth flows
  to the handler's entry-validation path (isValidRoundEntry should REJECT unknown... entries
  with recipient typed — check isValidRoundEntry passes entries carrying the new field (an
  optional field — additive typing must not reject).
