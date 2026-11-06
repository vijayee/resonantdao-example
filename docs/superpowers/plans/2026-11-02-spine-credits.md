# C_20/C_21 Spine Credits (Slice #6c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The settlement wizard's closing turns pay their designed contribution-token credits —
the reckoning driver's C_20 tally and the completing driver's C_21 tally, weight-scaled.

**Architecture:** Two handler-side credit blocks (the verify-tally idiom verbatim: declare-first,
raw prev read, `prev + toRegisterUnits(delta)`), spec'd 2026-11-02-spine-credits-design.md.
No client/UI/feed changes — tallies surface through the existing panels.

**Tech Stack:** shared TS (jest, TDD), Playwright e2e (assert-only).

Spec: `docs/superpowers/specs/2026-11-02-spine-credits-design.md`

---

## Task 1: the two credit blocks (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (makeReckonRoundHandler + makeCompleteRoundHandler)
- Test: `server/test/round.test.ts` (the spine handlers' suite — read its fixtures first)

- [ ] **Step 1: failing tests**:

```ts
// Contracts:
// SP-A: reckon_round (by alice): alice's C_20 tally += match(1) × alpha(20)
//       (unset-alpha default arc = 1.000; a seeded alpha(20)=2 arc = 2.000);
//       $RES/RCT balances unchanged; the op's existing effects unchanged.
// SP-B: complete_round (by alice): alice's C_21 tally += match(1) × alpha(21)
//       (default + seeded arcs); everything standing intact (RCT credits,
//       stage registers).
// SP-C: a SECOND legal drive on the same round (an appeal-rewound replay):
//       the tally accumulates (no dedupe guard — matches every tally).
// SP-D: $RES invariant: neither op moves a single res: register (assert
//       two members' balances before == after).
```

- [ ] **Step 2: FAIL → implement** — in each handler, after its existing writes, the credit block:

```ts
    // The designed spine credit (slice #6c): the driving member's dimension
    // tally, weight-scaled (the general calibration rule; match = 1, no harm
    // on spine ops).
    const alphaFor = (i: number) => fromRegisterUnits(state.getRegister(CALIBRATIONS.alpha(i)) || 0) || 1;
    const delta = dimensionDeltaFor(20, 1) * alphaFor(20);
    try { node.addRegister(CONTRIB_NAMES.dimensionBalance(op.signerId, 20), 0); } catch (err) { /* exists */ }
    const prevTally = state.getRegister(CONTRIB_NAMES.dimensionBalance(op.signerId, 20)) || 0;
    state.setRegister(CONTRIB_NAMES.dimensionBalance(op.signerId, 20), prevTally + toRegisterUnits(delta), op.signerId);
```

(C_21's block mirrors with dim 21 in the complete handler.)

- [ ] **Step 3: PASS + full jest + both typechecks.**

- [ ] **Step 4: commit**

```bash
git add shared/src/handlers.ts server/test/round.test.ts
git commit -m "feat(state): the spine pays its designed tally credits — C_20 on reckon, C_21 on complete (TDD)"
```

---

## Task 2: e2e pins + verification

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: add the tally pins** to the spine section (after the audited/reckoned/published
  chip asserts, before the /asserting RCT badge):

```js
  // The spine pays its designed tallies (slice #6c): alice's C_20 + C_21
  // chips, EXACT numbers (the pinned-assert standard; alpha defaults → 1).
  await alice.page.locator('.tally:has-text("C_20")').waitFor({ state: 'visible', timeout: 10000 });
  const c20Tally = await alice.page.locator('.tally:has-text("C_20")').textContent();
  if (!c20Tally || !c20Tally.includes('C_20')) throw new Error(`alice's C_20 tally missing: ${c20Tally}`);
  console.log('SPINE CREDIT C_20:', (c20Tally ?? '').trim());
  await nav(alice.page, '/account');
  const c20Account = await alice.page.locator('#dim-tallies').textContent();
  if (!c20Account || !c20Account.includes('C_20')) throw new Error(`alice's C_20 account tally missing: ${c20Account}`);
```

(+ the C_21 pin from her account tallies; adapt the selectors to the page's real classes by
reading them first.)

- [ ] **Step 2: node --check + commit:**
  `test(e2e): the spine's tally credits pinned — C_20 + C_21 on the driving member`

- [ ] **Step 3: full verification** (the standing recipe: stop dev by PID chains → build:client →
  fresh `WAVEDB_PATH=/tmp/dao-6c-e2e` server (real listen wait) → `node test-voting-browser.js` →
  `Smoke test passed` → fresh server + dev:client → `node scripts/feed-walk.mjs` → `FEED WALK
  PASSED` → gates (typecheck/build/devtools/dialog grep) → restart `npm run dev` for the user,
  leave running; rm -rf /tmp/dao-6c-e2e). Failures: fixtures fixable; shared bugs → BLOCKED
  with output.

---

## Close-out (controller)

The de-wonk audit loop LAST (the standing decree) — the question: anything unimplemented,
stubbed, disabled, broken, or weird; the answer closes the slice. Then the memory tail + the
final report.