# C_19 Sun — Public Recognition (Slice #6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognition becomes a submittable claim: schema-wired C_19, machine-checked tie to an accepted record, the recognized member's tally credit — and the general calibration rule restored (every tally credit = match × the dimension's live weight), plus the shell's dynamic-steps generalization so claim flows vary per chosen type.

**Architecture:** Protocol first (calibration term → every tally credit; the C_19 schema/payload/registers; the verify hook runs per-dim gates then credits the recognized member), then the shell's `steps(answers)` fn form, then the derived picker + the claim flow, then e2e.

**Tech Stack:** shared TS (jest, TDD), Vue 3 SFC + pinia, Playwright e2e.

Spec: `docs/superpowers/specs/2026-11-02-c19-recognition-design.md`

---

## Conventions

- npm from repo root; commits direct to master; never stage outside the task list; jest suites
  in `server/test/`; TDD strictly at pure seams; SFC trailing newlines; tick-gated computeds.
- IDIOMS (single-source): calibration read — `const alphaFor = (i: number) => fromRegisterUnits(state.getRegister(CALIBRATIONS.alpha(i)) || 0) || 1;` (handlers.ts:1251's exact form); tally write — setRegister(dimensionBalance(target, dim), prev + toRegisterUnits(delta), signer); the verify tally-credit lives at shared/src/handlers.ts:~308 (`delta = dimensionDeltaFor(dim, match) * harmFactor`).

## Final file layout

```
Modified:
  shared/src/handlers.ts                        # calibration term + C_19 validation/stamps + dim-gate hook + recognized tally
  shared/src/contribution.ts                    # DIMENSIONS[19].implemented + the C_19 schema + dimensionDeltaFor doc
  shared/src/types.ts                           # RecognitionPayload
  shared/src/policies.ts                        # CONTRIB_NAMES.recognized/recordTie
  server/test/targeted-verification.test.ts     # calibration re-pin tests (alpha defaults keep numbers)
  server/test/c19-recognition.test.ts           # NEW: the C_19 contracts (TDD)
  client/src/wizard/types.ts                    # FlowDefinition steps fn form (TDD)
  server/test/wizard-steps.test.ts              # (the fn-form's validateStep interplay — the rail resolves per render)
  client/src/wizard/WizardFlow.vue              # resolves steps(answers) per render
  client/src/wizard/flows/contribute-flows.ts   # picker derivation + the C_19 claim steps + DIM_DESCS
  test-voting-browser.js                        # the recognition arc
```

---

## Task 1: the general calibration rule — every tally credit weights (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (the verify handler's tally credit, ~:308)
- Test: `server/test/targeted-verification.test.ts`

- [ ] **Step 1: failing tests** (append — follow the suite's fixture idioms):

```ts
// Contracts:
// CAL-A: with NO alpha register set (the default), a verified C_2 tally
//        credit = match × 1 — the standing numbers are UNCHANGED (the
//        re-pin is a no-op against defaults). Assert dimBalance(alice, 2)
//        equals the pre-slice value for the same arc.
// CAL-B: with the custodian alpha C_2 set to 2 (CALIBRATIONS.alpha(2) →
//        seed via state.setRegister + toRegisterUnits like the settle
//        handler's own alpha seeds), the SAME arc's tally credit = match × 2.
// CAL-C: an UNSET dim's alpha (e.g. C_1 untouched) stays 1 — only seeded
//        dims scale (the || 1 default, machine-wide).
```

- [ ] **Step 2: FAIL** — CAL-B fails (today's credit ignores alpha).

- [ ] **Step 3: implement** — at the verify handler's tally credit (~:308), add the calibration term BEFORE the write:

```ts
        // The calibration term (slice #6a's general rule): the dimension's
        // live weight scales every tally credit — the same register the RCT
        // aggregation reads; default weight 1 (the :1251 idiom).
        const alphaFor = (i: number) => fromRegisterUnits(state.getRegister(CALIBRATIONS.alpha(i)) || 0) || 1;
        const delta = dimensionDeltaFor(dimIndex, match) * alphaFor(dimIndex) * harmFactor;
```

(the surrounding write shape is unchanged; `CALIBRATIONS` is already imported.)

- [ ] **Step 4: PASS + full jest green** (every pre-existing tally fixture with unset alphas keeps its numbers — CAL-A is the backstop).

- [ ] **Step 5: commit**

```bash
git add shared/src/handlers.ts server/test/targeted-verification.test.ts
git commit -m "feat(state): tally credits carry the calibration term (match × alpha × harm)"
```

---

## Task 2: the C_19 schema + claim payload + registers (TDD)

**Files:**
- Modify: `shared/src/contribution.ts` (DIMENSIONS[19].implemented → true; the C_19 v2 schema in the SCHEMAS loop)
- Modify: `shared/src/types.ts` (RecognitionPayload)
- Modify: `shared/src/policies.ts` (CONTRIB_NAMES.recognized / recordTie)
- Test: `server/test/c19-recognition.test.ts` (new suite; MockNode/MockState copied per precedent)

- [ ] **Step 1: failing tests** (the wiring contracts):

```ts
// Contracts:
// W-A: SCHEMAS.get(19) exists; steps are submit/verify/settle with the
//      verify step's actors ['verifier'] + requirement single/1;
//      DIMENSIONS[19].implemented === true.
// W-B: dimensionDeltaFor(19, 1) === 1 (the match rule — the WEIGHT lives at
//      the call site, never in this fn).
```

- [ ] **Step 2: FAIL → 3. implement:**

`shared/src/contribution.ts` — the implemented flags: `{ index: 19... implemented: true }`; the SCHEMAS loop gains the dim 19 branch (same shape as the 1/2 loop):

```ts
for (const dimIndex of [1, 2, 19]) {
  SCHEMAS.set(dimIndex, {
    dimIndex,
    schemaVersion: SCHEMA_VERSION,
    steps: [SUBMIT_STEP, dimIndex === 1 ? C1_VERIFY_V2 : VERIFY_STEP, SETTLE_STEP],
  });
}
```

`shared/src/types.ts`:

```ts
export interface RecognitionPayload {
  contributionId: string;
  dims: Record<string, number>;      // { '19': 1 }
  summary: string;
  evidenceRef: EvidenceRef;
  schemaVersion: string;
  recognized: string;                // the member whose work is recognized (≠ submitter)
  recordId: string;                  // the tied contribution (machine-checked accepted)
}
```

(Check how EvidenceRef/ContributionPayload are imported/typed in types.ts and follow — if
RecognitionPayload EXTENDS a shared base claim type, do that instead; adjust to the file's
actual shapes.)

`shared/src/policies.ts` — inside CONTRIB_NAMES:

```ts
  // C_19's ties (recognition): the recognized member + the linked record.
  recognized: (contributionId: string) => `contrib:${contributionId}:rec`,
  recordTie: (contributionId: string) => `contrib:${contributionId}:tie`,
```

`implemented` flags carry the real semantics — flip C_19's ONLY in this slice.

- [ ] **Step 4: PASS + full jest.** Commit:

```bash
git add shared/src/contribution.ts shared/src/types.ts shared/src/policies.ts server/test/c19-recognition.test.ts
git commit -m "feat(state): the C_19 schema — recognition is a submittable claim (TDD)"
```

---

## Task 3: submit — C_19 claim validation + tie stamps (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (the submit handler)
- Test: `server/test/c19-recognition.test.ts`

- [ ] **Step 1: failing tests** (append):

```ts
// Contracts:
// S-A: alice submits a valid C_19 claim (recognized: bob, recordId: an
//      ACCEPTED c-1 she submitted... any member's accepted contribution;
//      the fixtures build it with the real submit/verify handlers) → 0; the
//      registers hold recognized=bob (setContains) and the recordTie... the
//      tie is a STRING (recordId) — read via... store the tie as an OR-set
//      ELEMENT: state.setAdd(CONTRIB_NAMES.recordTie(id), recordId, tag);
//      assert setContains(recordTie, recordId).
// S-B: recognized === op.signerId (self-recognition) → -1.
// S-C: recognized not a member → -1.
// S-D: recordId not an existing contribution (setContains(STATE_NAMES.contributions, ...)) → -1.
```

- [ ] **Step 2: FAIL → 3. implement** — in the submit handler, BEFORE the register-write block, when the payload carries dim 19 (the gate keys off the dims the way the calibration hook will):

```ts
    // C_19 recognition claims (the claim's ties validate + stamp here):
    if (isValidDims(payload.dims) && payload.dims['19'] !== undefined) {
      const rec = (payload as RecognitionPayload).recognized;
      const tie = (payload as RecognitionPayload).recordId;
      if (
        !isNonEmptyString(rec) || rec === op.signerId || !state.setContains(STATE_NAMES.members, rec) ||
        !isNonEmptyString(tie) || !state.setContains(STATE_NAMES.contributions, tie)
      ) {
        return -1;
      }
      // stamps (after the resource-declaring block):
    }
```

with, in the register-write block:

```ts
    try { node.addORSet(CONTRIB_NAMES.recognized(payload.contributionId)); } catch (err) { /* duplicate */ }
    try { node.addORSet(CONTRIB_NAMES.recordTie(payload.contributionId)); } catch (err) { /* duplicate */ }
    if (payload.dims['19'] !== undefined) {
      state.setAdd(CONTRIB_NAMES.recognized(payload.contributionId), rec, `submit:rec:${op.signerId}`);
      state.setAdd(CONTRIB_NAMES.recordTie(payload.contributionId), tie, `submit:tie:${op.signerId}`);
    }
```

(type note: `payload` is typed ContributionPayload — the C_19 fields ride the payload; the
cleanest typing is extending ContributionPayload with OPTIONAL `recognized?/recordId?` fields
(documented: set only on C_19 claims) and validating them when present — CHOOSE THAT over the
cast; adjust the type in types.ts in Task 2 accordingly.)

- [ ] **Step 4: PASS + full jest.** Commit:

```bash
git add shared/src/handlers.ts shared/src/types.ts server/test/c19-recognition.test.ts
git commit -m "feat(state): the recognition claim validates its ties and stamps the registers (TDD)"
```

---

## Task 4: verify — the dim-gate hook + the recognized tally credit (TDD)

**Files:**
- Modify: `shared/src/handlers.ts` (the verify handler)
- Test: `server/test/c19-recognition.test.ts`

- [ ] **Step 1: failing tests** (append):

```ts
// Contracts:
// G-A: THE GATE: a pass on a C_19 claim whose recordTie points at a
//      contribution whose status register is NOT accepted (pending fixture)
//      → -1.
// G-B: recordTie unregistered/cleared (no set elements) → -1.
// G-C: the happy arc: claim → named reviewer pass → the RECOGNIZED member's
//      C_19 tally += match × alphaFor(19) (the calibration! assert with the
//      default weights = match; and withalpha(19) seeded = the scaled value);
//      the SUBMITTER earns nothing on C_19 (no $RES movement — assert
//      balance unchanged).
// G-D: settle completes the arc like every schema (the settle step records;
//      no money moves).
```

- [ ] **Step 2: FAIL → 3. implement** — in the verify handler, before the pass path records:

```ts
    // The dimension gate hook (slice #6a): per-dim predicates the pass must
    // satisfy. C_19: the recognition's tie is REAL (the record exists AND
    // its status is the machine's accepted).
    if (isValidDims(payload.dims) && payload.dims['19'] !== undefined && payload.pass) {
      const tieNamed = state.setContains(CONTRIB_NAMES.recordTie(payload.contributionId), ...)
```

CORRECTION (apply as written): handlers cannot ENUMERATE the tie OR-set's element — store the
tie as a REGISTERED string... registers are numeric. RESOLUTION: keep the tie in the OR-set AND
mirror the recognition payload's recordId into the VERIFY op itself: the verify payload for a
C_19 claim re-carries `recordId` (the client's verify builder includes it; the handler
cross-checks it against... against WHAT state? The GATE then reads the RECORD's status register
directly: `state.getRegister(CONTRIB_NAMES.status(payload.recordId)) === STATUS_ACCEPTED` — the
recordId rides the VERIFY payload (validated as an existing contribution at verify). The claim's
own submit stamp (tie OR-set) stays as the permanent record but the GATE uses the verify
payload's recordId — the machine cannot read back the claim's fields otherwise. Final gate:
`if C_19 && pass && (!isNonEmptyString(payload.recordId) || !state.setContains(STATE_NAMES.contributions, payload.recordId) || state.getRegister(CONTRIB_NAMES.status(payload.recordId)) !== STATUS_ACCEPTED) return -1;` — the dao's verify builder (client/src/dao.ts verifyContribution) passes the record through from the CLAIM's mirror... the MIRROR must expose the tie (a dao accessor getRecordTie(id) via setContains-scan over... the tie's value is an arbitrary string — the scan can't work without knowing candidates!) — RESOLUTION B (final): the mirror ALSO stamps `entry.recordIdTie` from the SUBMIT op's payload (client/src/dao.ts's submit-mirror already parses the payload — read the tie field); the store's verify flow then carries `recordId: entry.recordIdTie` in the verify payload; the handler's gate reads the payload's recordId + the record's status register. Jest asserts the handler's gate per this contract shape (payload carries recordId).

    and the tally credit — in the SAME handler where the submitter's tally credit fires
    (~:308-315), when dims carry 19: the credit's TARGET is the recognized member (read from...
    the C_19 verify payload also carries `recognized` — same pattern as recordId). Add AFTER the
    submitter credit block:

```ts
        // Recognition: the RECOGNIZED member carries the credit (no $RES).
        if (rec && rec !== payload.submitter) {
          const recPrev = state.getRegister(CONTRIB_NAMES.dimensionBalance(rec, 19)) || 0;
          state.setRegister(CONTRIB_NAMES.dimensionBalance(rec, 19), recPrev + toRegisterUnits(delta), op.signerId);
        }
```

- [ ] **Step 4: PASS + full jest.** Commit:

```bash
git add shared/src/handlers.ts client/src/dao.ts server/test/c19-recognition.test.ts
git commit -m "feat(state): the C_19 gate + the recognized member's weighted tally credit (TDD)"
```

---

## Task 5: the shell's dynamic steps (TDD)

**Files:**
- Modify: `client/src/wizard/types.ts` (FlowDefinition's steps fn form)
- Test: `server/test/wizard-steps.test.ts`

- [ ] **Step 1: failing test** (the fn form's TYPE + the resolution contract):

```ts
  it('FlowDefinition steps may be a function of the answers (the claim family varies per type)', () => {
    // A structural test: the fn form compiles + the type is honest.
    const flow: FlowDefinition = {
      id: 'claim', title: 'Claim',
      steps: (a) => (a.dim === '19' ? [textStep, reviewStep] : [reviewStep]),
      reviewSummary: () => [],
      submit: async () => {},
    };
    expect(typeof flow.steps).toBe('function');
  });
```

(textStep/reviewStep are the existing fixtures' shapes in that suite — reuse.)

- [ ] **Step 2: FAIL → 3. implement** — the union:

```ts
export interface FlowDefinition {
  id: string;
  title: string;
  steps: FlowStep[] | ((answers: FlowAnswers) => FlowStep[]);
  reviewSummary(answers: FlowAnswers, files?: Record<string, string | null>): string[];
  submit(answers: FlowAnswers, files?: Record<string, File | null>): Promise<void>;
}
export function flowSteps(def: FlowDefinition, answers: FlowAnswers): FlowStep[] {
  return typeof def.steps === 'function' ? def.steps(answers) : def.steps;
}
```

and `WizardFlow.vue`: replace every `flow.steps` read with `allSteps` computed = `flowSteps(props.flow, answers.value)`; `current`/`committedAnswers`' shape uses allSteps; the rail maps allSteps. (The draft's stepIndex clamps against allSteps' length — the existing Math.min logic reads the computed.)

- [ ] **Step 4: PASS + full jest + typecheck.** Commit:

```bash
git add client/src/wizard/types.ts client/src/wizard/WizardFlow.vue server/test/wizard-steps.test.ts
git commit -m "feat(wizard): dynamic steps — flows vary their step list by the answers (TDD)"
```

---

## Task 6: the picker derives + the C_19 claim flow (client)

**Files:**
- Modify: `client/src/wizard/flows/contribute-flows.ts`

- [ ] **Step 1: the derivation** — replace the hardcoded dim options:

```ts
// The picker derives from the machine's own vocabulary: submittable =
// implemented ∧ schema-wired. The descs are client copy (the domain carries
// names/classes; the selling lines live here).
const DIM_DESCS: Record<number, string> = {
  1: 'built something real — bounty 12 $RES',
  2: 'a durable, findable record — base credit 3 $RES',
  19: 'recognize someone’s proven work — credits their C_19 tally (the tie is machine-checked)',
};

function dimensionOptions(): Array<{ value: string; label: string; desc: string }> {
  const ds = useDaoStore();
  void ds.tick;
  return [...DIMENSIONS.filter((d) => d.implemented && SCHEMAS.has(d.index))]
    .map((d) => ({ value: String(d.index), label: `${d.code} ${d.name} — ${d.cls}`, desc: DIM_DESCS[d.index] ?? '' }));
}
```

and use it in the contribute-new flow's steps (the members/dynamic-steps family):

```ts
      { kind: 'choice', id: 'dim', title: 'What kind of contribution?', options: dimensionOptions() },
```

- [ ] **Step 2: the claim steps go dynamic** — the contribute-new flow's `steps` becomes a function: the dim choice first; when the answer is 19, the recognition ties (recognized member pick — the 'members' kind with count 1 options = members minus self, screened reciprocity-clear; record pick — members kind count 1 options = THE VIEWER'S OWN ACCEPTED contribution ids (via the dao mirror: contributions of mine with accepted status — their contributionId strings as options, labeled by summary? the members kind prints options raw — use SHORT ids? The ties' ids as options are ugly; the factory supplies the accepted summaries MAPPED to ids... the members kind's option value must be the CONTRIBUTION ID while the LABEL shows the summary — the kind is label=value today. Extend? NO — use the id strings and put the summary in... simplest honest: options = ids; the review line shows the mapped summary. Acceptable (LOW)); then the common tail: reviewer pick (verifiers, count by schema), summary, evidence, review.

```ts
    steps: (a) => [
      dimChoiceStep,
      ...(Number(a.dim) === 19 ? [recognizedPickStep, recordPickStep] : []),
      reviewerPickStep(a),
      summaryStep, evidenceStep, reviewStep,
    ],
```

(the submit wrapper parses all three picks into the payload: `recognized`/`recordId` (C_19) + `verifiers`; C_1/C_2 unchanged in behavior.)

- [ ] **Step 3: typecheck + jest + build:client.** Commit:

```bash
git add client/src/wizard/flows/contribute-flows.ts
git commit -m "feat(contribute): the picker derives from the machine; the recognition claim walks its ties"
```

---

## Task 7: e2e — the recognition arc

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: the arc** (after a settled C_2 exists — the cycle-1 summary is the tie):

```js
  // ---------- C_19 recognition ----------
  console.log('Recognition: alice recognizes bob’s accepted record');
  await nav(alice.page, '/contribute');
  await alice.page.click('#new-contribution-btn');
  const claimFlow = alice.page.locator('.wizard-flow[data-flow-id="contribute-new"]');
  await claimFlow.waitFor({ state: 'visible', timeout: 10000 });
  await claimFlow.locator('.wizard-option[value="19"]').check();   // the DERIVED picker carries C_19
  await claimFlow.locator('.wizard-next').click();
  // The recognized member pick (count 1): bob.
  await claimFlow.locator(`.wizard-member[value="${bob.name}"]`).check();
  await claimFlow.locator('.wizard-next').click();
  // The record tie pick (count 1): the accepted C_2's id — the options are
  // contribution ids; pick the settled one's id from the e2e's own records.
  await claimFlow.locator(`.wizard-member[value="${settledContributionId}"]`).first().check();
  await claimFlow.locator('.wizard-next').click();
  // The reviewer pick + summary + evidence + review — drive per the
  // established completeFlow mechanics on this flow's remaining steps
  // (dave reviews).
  await claimFlow.locator(`.wizard-member[value="${dave.name}"]`).check();
  await claimFlow.locator('.wizard-next').click();
  await claimFlow.locator('textarea').first().fill('recognition claim: bob’s proven work');
  await claimFlow.locator('.wizard-next').click();
  await claimFlow.locator('.wizard-evidence-pointer').fill('https://example.com/evidence/rec');
  await claimFlow.locator('.wizard-next').click();
  await claimFlow.locator('.wizard-submit').click();
  await alice.page.waitForURL(/\/contribute\/[0-9a-f-]{36}$/, { timeout: 30000 });
  // dave reviews: THE GATE rejects a bogus tie — the arc's tie is real, the
  // pass records; then bob's C_19 tally shows the increment.
  await runContributionFlow(dave, 'recognition claim', 'verify', { choiceValue: 'yes', textValue: 'tie confirmed' });
  await nav(dave.page, '/account');   // the tally panel is bob's — check on BOB's page:
  await nav(bob.page, '/account');
  const tallies = await bob.page.locator('#dim-tallies').textContent();
  if (!tallies.includes('C_19')) throw new Error(`bob's C_19 tally missing; ${tallies}`);
```

(the e2e's actual variable names/summaries come from the file — read first; the tie id is the
variable the settled cycle produced if retained — read the file's cycle summary/id plumbing and
pin the string accordingly.)

- [ ] **Step 2: node --check + commit:**

```bash
git add test-voting-browser.js
git commit -m "test(e2e): the recognition arc — derived picker, ties, the gate, the tally"
```

---

## Task 8: full verification + hand-back

**Files:** none expected.

- [ ] **Step 1:** stop the dev server (full PID chain; ports free; NEVER touch ./data — always WAVEDB_PATH=/tmp/…).
- [ ] **Step 2:** `npm run build:client` → fresh `WAVEDB_PATH=/tmp/dao-6a-e2e` server (real listen wait) → `node test-voting-browser.js` → `Smoke test passed` (the arc incl. the C_19 tally assert; NOTE: the calibration rule (Task 1) may shift e2e numbers ONLY where the e2e SEEDS alpha (the quadratic weights section) — re-pin any shifted assert against the seeded weight).
- [ ] **Step 3:** fresh server + dev:client → `node scripts/feed-walk.mjs` → `FEED WALK PASSED`.
- [ ] **Step 4:** gates — `npm test` (17 suites green), typecheck 0, `npm run build` clean, devtools assert, dialog grep 0.
- [ ] **Step 5:** restart `npm run dev` for the user; rm -rf /tmp/dao-6a-e2e.

---

## Self-review notes (executed)

- Spec coverage: the general calibration rule (Task 1), schema/claims/registers (Tasks 2-3),
  the dim gate + recognized tally (Task 4), dynamic steps (Task 5), derivation + claim flow
  (Task 6), e2e (Task 7), verification (Task 8). The spec's ledger-no-line + subject-riding
  fall out of the machine shape (no extra work).
- Type consistency: `RecognitionPayload` fields (recognized/recordId; Task 2's optional-fields
  resolution rides ContributionPayload — Task 3's instructions agree); the verify payload's
  tie re-carry (Task 4's RESOLUTION B — the dao's mirror/submit tie read + the verify builder's
  pass-through) is the plan's OWN resolution — reviewers check the mirror read (entry.recordIdTie)
  + the payload fields against the implementation.
- Known-red windows: Tasks 5→6 (dynamic steps before the flow uses them — typecheck stays
  green; no window), none — each task is self-contained green.