# Round Settlement Wizard (Slice #4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/round` becomes ONE always-present settlement wizard (stage → flow definition: audit → reckon → publish), the entry buttons die, the weights panel moves to `/custodians`, and the user-visible copy drops the spine metaphor.

**Architecture:** No shell changes — the slice #3 `WizardFlow.vue` is reused verbatim; the round page derives which FlowDefinition to mount from the dao's round stage (`stageFlowFor`). `completeRound` joins its five siblings in the `Promise<boolean>` contract; `publishFlow` is a zero-input flow whose review renders the aggregation preview (the old snap-error guard becomes displayed state).

**Tech Stack:** Vue 3 SFC + pinia, Playwright e2e (both drivers), no shared-source changes.

Spec: `docs/superpowers/specs/2026-10-25-round-settlement-wizard-design.md`

---

## Conventions

- npm from repo root; commits direct to master; never stage outside the task list.
- SFC trailing newlines; scoped styles use design tokens only.
- jest suites in `server/test/`; `npm test` green at each task boundary.

## Final file layout

```
Modified:
  client/src/stores/dao.ts                              # completeRound → Promise<boolean>
  client/src/wizard/flows/round-flows.ts                # + publishFlow, + stageFlowFor
  client/src/components/round/RoundPage.vue             # rewritten: always-on wizard
  client/src/components/custodians/CustodiansPage.vue   # + weights panel
  test-voting-browser.js                                # runRoundSpineStep retarget
  scripts/feed-walk.mjs                                 # audit/reckon sections retarget
```

---

## Task 1: `completeRound()` → `Promise<boolean>`

**Files:**
- Modify: `client/src/stores/dao.ts` (the `completeRound` function)

- [ ] **Step 1: apply the boolean contract** — replace the guard/return shape of `completeRound` (same pattern as its five slice #3 siblings):

```ts
  async function completeRound(): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value) return false;
    submitting.value = true;
    try {
      const currentRound = d.getCurrentRound();
      const entries = d.getContributions()
        .filter((entry) => d.getContributionStatus(entry.record.contributionId) === 'accepted'
          && d.getContributionRound(entry.record.contributionId) === currentRound)
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter, dims: entry.record.dims, harm: entry.harm ?? ('none' as const) }));
      if (entries.length === 0) {
        status.set('Nothing settled to aggregate in this round.', 'error');
        return false;
      }
      const bytes = await d.completeRound(username.value, { entries });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Round published — ${entries.length} contribution(s) aggregated.`, 'success');
      bump();
      return true;
    } catch (err) {
      status.set(`Complete error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }
```

- [ ] **Step 2: typecheck** (no callers change signature-wise — zero-arg before and after)

Run: `npm run typecheck:client` → 0 errors.

- [ ] **Step 3: commit**

```bash
git add client/src/stores/dao.ts
git commit -m "refactor(stores): completeRound returns boolean success (publishFlow's contract)"
```

---

## Task 2: `publishFlow` + `stageFlowFor`

**Files:**
- Modify: `client/src/wizard/flows/round-flows.ts`

- [ ] **Step 1: extend the file** — add after the existing `reckonFlow` factory (imports first: add the shared stage constants):

```ts
import { STAGE_AUDITED, STAGE_OPEN, STAGE_RECKONED } from '@shared/round';
```

```ts
// Zero-input publish: the review step IS the aggregation preview. The old
// UI's snap-error ('Nothing settled to aggregate') becomes displayed state —
// visible in the summary before anyone confirms.
export function publishFlow(round: number): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'publish',
    title: `Publish round ${round}`,
    steps: [{ kind: 'review' }],
    reviewSummary: () => {
      void ds.tick;
      const d = ds.dao;
      if (!d) return ['(no dao state yet)'];
      const accepted = d.getContributions().filter(
        (e) => d.getContributionStatus(e.record.contributionId) === 'accepted'
          && d.getContributionRound(e.record.contributionId) === round,
      );
      const lines = [`Aggregating ${accepted.length} accepted contribution(s) from round ${round}.`];
      if (accepted.length === 0) lines.push('Nothing settled to aggregate — publishing records an empty round.');
      return lines;
    },
    submit: async () => {
      const ok = await ds.completeRound();
      if (!ok) throw new Error('The round did not publish — check the message below the page.');
    },
  };
}

// The /round page hosts ONE always-present wizard; the round's stage selects
// which flow it renders. No activeFlow state exists — stage and round changes
// remount via the instance key the page computes (stale-initial insurance).
export function stageFlowFor(stage: number, round: number): FlowDefinition | null {
  if (stage === STAGE_OPEN) return auditFlow(round);
  if (stage === STAGE_AUDITED) return reckonFlow(round);
  if (stage === STAGE_RECKONED) return publishFlow(round);
  return null;
}
```

- [ ] **Step 2: typecheck + jest**

Run: `npm run typecheck:client` → 0 errors; `npm test` → green.

- [ ] **Step 3: commit**

```bash
git add client/src/wizard/flows/round-flows.ts
git commit -m "feat(wizard): publishFlow preview + stageFlowFor (the round page's derivation)"
```

---

## Task 3: RoundPage rewrite — the always-on wizard

**Files:**
- Modify: `client/src/components/round/RoundPage.vue` (complete rewrite — the file is small)

- [ ] **Step 1: replace the whole file with:**

```vue
<template>
  <SectionHeading number="04" eyebrow="Round" title="The settlement cycle">
    <template #lede>Each round gathers accepted contributions; any member then closes it —
      audit, reckon, publish — and the aggregation pays the round's settled work. The wizard
      below always shows the current stage.</template>
  </SectionHeading>

  <Panel number="01" kicker="Settlement wizard">
    <div id="round-stepper" class="round-stepper">
      <span class="round-label">Round {{ current }} — stage: {{ stageNames[stage] ?? 'unknown' }}</span>
      <span v-for="(name, i) in stageNames" :key="name" :class="['round-step', i < stage ? 'round-step--complete' : i === stage ? 'round-step--current' : 'round-step--locked']">{{ name }}</span>
    </div>
    <div id="round-explanations" class="muted">{{ explanations }}</div>

    <div v-if="stageFlow" class="round-wizard">
      <WizardFlow
        :key="wizardKey"
        :flow="stageFlow"
        :target-id="String(current)"
        :initial-answers="stageResume?.answers"
        :initial-step="stageResume?.stepIndex"
        @close="onWizardClose"
      />
    </div>
    <div v-else id="round-published" class="muted">The round is published — the next round is gathering fresh work.</div>
  </Panel>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import WizardFlow from '../../wizard/WizardFlow.vue';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import { stageFlowFor } from '../../wizard/flows/round-flows';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const stageNames = ['Open', 'Audited', 'Reckoned', 'Published'];

const current = computed(() => { void ds.tick; return ds.dao?.getCurrentRound() ?? 1; });
const stage = computed(() => { void ds.tick; return ds.dao?.getRoundStage(current.value) ?? 0; });
const explanations = computed(() => {
  void ds.tick;
  const records = ds.dao?.getRoundRecords(current.value) ?? [];
  return records.map((r) => `${String(r.stepId)}: ${String(r.note ?? '')}`).join(' | ');
});

// No open/close state: the wizard IS the page. The key bakes stage + round +
// an epoch so a Cancel re-mounts from the flow's first step (the shell has
// already cleared the draft); stage/round changes remount naturally.
const wizardEpoch = ref(0);
const stageFlow = computed(() => { void ds.tick; return stageFlowFor(stage.value, current.value); });
const stageResume = computed(() => {
  if (!ds.username || !stageFlow.value) return null;
  return loadDraft(localStorage, ds.username, stageFlow.value.id, String(current.value));
});
const wizardKey = computed(() => `${stage.value}-${current.value}-${wizardEpoch.value}`);
function onWizardClose() { wizardEpoch.value += 1; }
</script>

<style scoped>
.round-stepper { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.round-label { font-family: var(--font-mono); font-size: .85rem; font-weight: 500; color: var(--ink); }
.round-step { font-family: var(--font-mono); font-size: .72rem; font-weight: 500; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.round-step--complete { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.round-step--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.round-step--locked { opacity: .6; border-style: dashed; }
.round-stepper + #round-explanations { margin-top: var(--space-3); }
.round-wizard { margin-top: var(--space-3); }
#round-published { margin-top: var(--space-3); }
</style>
```

(The stage chips + stepper styles are the existing ones; `useStatusStore`, the STAGE_* imports, the buttons, the weights panel, and the whole openFlow/watch/alpha machinery are DELETED with the old page.)

- [ ] **Step 2: typecheck** — still red until Task 4 (CustodiansPage doesn't need it, but the page drops exports nothing else used — should be green if nothing referenced the weights form by id; run and check nothing NEW appears. RoundPage errors would mean the deleted ids/classes are referenced elsewhere — run `npm run typecheck:client 2>&1 | grep RoundPage` → 0.)

- [ ] **Step 3: no commit yet (Task 4's panel moves complete the slice; commit both pages together).**

---

## Task 4: weights panel → `/custodians`

**Files:**
- Modify: `client/src/components/custodians/CustodiansPage.vue`

- [ ] **Step 1: append the weights panel** — insert a fourth `Panel` after the existing custodian-controls Panel (`.cols` grid wrapper — place the new Panel INSIDE the `cols` div so it lands as the next grid cell; if the grid's column count is 3, move the new panel AFTER the closing `</div>` as a standalone panel — visual verification during the walk decides; shipping default: inside `.cols`):

```vue
    <Panel number="04" kicker="Weights (custodian)">
      <form class="proposal-form" :class="{ hidden: !ds.isCustodian }" @submit.prevent>
        <div class="form-group"><input id="alpha-c1" v-model="alpha.c1" class="form-input" type="text" placeholder="alpha C_1 (e.g. 2)" /></div>
        <div class="form-group"><input id="alpha-c2" v-model="alpha.c2" class="form-input" type="text" placeholder="alpha C_2 (e.g. 0.5)" /></div>
        <div class="form-group"><input id="alpha-version" v-model="alpha.version" class="form-input" type="text" placeholder="weights version label" /></div>
        <div class="proposal-form__actions">
          <button id="set-alpha-btn" class="button button--secondary" type="button" :disabled="ds.submitting" @click="onSetAlpha">Set weights</button>
          <button id="set-calibration-btn" class="button button--secondary" type="button" :disabled="ds.submitting" @click="ds.setCalibrationVersion">Set calibration v1</button>
        </div>
      </form>
      <p v-if="!ds.isCustodian" class="muted">Custodian-only controls.</p>
    </Panel>
```

- [ ] **Step 2: script additions** (imports + the moved state/handler verbatim from the old RoundPage):

```ts
import { computed, reactive } from 'vue';    // reactive joins computed
import { useStatusStore } from '../../stores/status';
```

```ts
const status = useStatusStore();
const alpha = reactive({ c1: '', c2: '', version: '' });

async function onSetAlpha() {
  const raw: Record<string, number> = {};
  const c1 = parseFloat(alpha.c1);
  const c2 = parseFloat(alpha.c2);
  if (Number.isFinite(c1) && c1 > 0) raw['1'] = c1;
  if (Number.isFinite(c2) && c2 > 0) raw['2'] = c2;
  const version = alpha.version;
  if (Object.keys(raw).length === 0 || !version.trim()) {
    status.set('At least one weight and a version label are required.', 'error');
    return;
  }
  await ds.setRctAlpha(raw, version.trim());
  if (status.kind === 'success') alpha.c1 = alpha.c2 = alpha.version = '';
}
```

- [ ] **Step 3: gates — the slice's typecheck goes green here**

Run: `npm run typecheck:client` → 0 errors; `npm test` → green; `npm run build:client` → success.

- [ ] **Step 4: commit**

```bash
git add client/src/components/round/RoundPage.vue client/src/components/custodians/CustodiansPage.vue
git commit -m "feat(round): /round becomes the always-on settlement wizard; weights move to custodians"
```

---

## Task 5: main e2e retarget

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: replace `runRoundSpineStep`** (the whole function) with:

```js
// The /round page hosts ONE always-present settlement wizard; the round's
// stage selects the flow (audit at Open, reckon at Audited, publish at
// Reckoned). Drive the current stage's flow, then wait for the stage chip to
// flip to the expected stage name. After publish the round ADVANCES (next
// round, stage Open again) — hence afterStage for publish is 'Open'.
async function runRoundSpineStep(actor, flowId, note, choiceValue = null, afterStage) {
  await nav(actor.page, '/round');
  let driven = false;
  for (let attempt = 0; !driven && attempt < 15; attempt++) {
    if (await actor.page.locator(`.wizard-flow[data-flow-id="${flowId}"]`).count()) {
      await completeFlow(actor.page, flowId, { choiceValue, textValue: note ?? '' });
      driven = await actor.page
        .locator(`.round-step--current:text-is("${afterStage}")`)
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true, () => false);
    } else {
      await actor.page.waitForTimeout(1000);
    }
  }
  if (!driven) {
    const statusBar = await actor.page.locator('#status').textContent();
    throw new Error(`Round spine stuck at ${flowId}; stage chip never reached "${afterStage}". Status bar: ${statusBar || '(empty)'}`);
  }
  console.log(`ROUND STAGE: ${afterStage.toLowerCase()}`);
}
```

Note `completeFlow`'s return is ignored inside the loop (the chip flip is the assertion) — the loop retries through draft-resume re-entry as designed.

- [ ] **Step 2: update the three call sites** (they currently pass button ids):

```js
  await runRoundSpineStep(alice, 'audit', 'phase-4a e2e audit note: fair against v1', 'fair', 'Audited');
  console.log('ROUND STAGE: audited');   // ← this existing duplicate log line DELETED (the helper logs it)
  await runRoundSpineStep(alice, 'reckon', 'phase-4a e2e reckon note: records settled', null, 'Reckoned');
  console.log('ROUND STAGE: reckoned');  // ← DELETED same rule
  await runRoundSpineStep(alice, 'publish', null, null, 'Open');
```

Check the publish call site's surrounding asserts — anything that previously waited on `complete-round-btn` disappears (the publish step submits directly); the existing post-publish assertions (round 2 aggregation, quadratic proposal section) keep their own waits.

- [ ] **Step 3: straggler sweep** — `grep -n "audit-round-btn\|reckon-round-btn\|complete-round-btn" test-voting-browser.js scripts/feed-walk.mjs` → must be 0 after this task (feed-walk's own sites go in Task 6).

- [ ] **Step 4: syntax check + commit**

Run: `node --check test-voting-browser.js` → clean.

```bash
git add test-voting-browser.js
git commit -m "test(e2e): the spine drives the always-on settlement wizard"
```

---

## Task 6: feed walk retarget

**Files:**
- Modify: `scripts/feed-walk.mjs`

- [ ] **Step 1: rewrite the audit block** (currently clicks `#audit-round-btn` then drives) — the wizard is always present:

```js
  // Spine: the /round wizard is always present; audit is the stage's flow.
  await nav(viewer2, '/round');
  const auditFlow = viewer2.locator('.wizard-flow[data-flow-id="audit"]');
  await auditFlow.waitFor({ state: 'visible', timeout: 10000 });
  await auditFlow.locator('.wizard-option[value="fair"]').check();
  await auditFlow.locator('.wizard-next').click();
  await auditFlow.locator('textarea').fill('feed walk audit note');
  await auditFlow.locator('.wizard-next').click();
  await auditFlow.locator('.wizard-submit').click();
  await viewer2.waitForTimeout(2000);
  await nav(viewer2, '/');
  rows = await viewer2.locator('.event-row').allTextContents();
  if (!rows.some((t) => t.includes('round 1 audited — fair'))) fail(`round_audited row missing; rows=${JSON.stringify(rows)}`);
```

- [ ] **Step 2: rewrite the reckon block** (same shape as today but without the button gate — the flow's presence at the reckon stage is the gate):

```js
  // Publish path needs accepted contributions — skip (covered by the main
  // e2e); assert the RECKON step event instead. The reckoning flow mounts
  // when the stage is Audited; give the op its 2000ms then move on.
  await nav(viewer2, '/round');
  const reckonFlow = viewer2.locator('.wizard-flow[data-flow-id="reckon"]');
  if (await reckonFlow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
    const textarea = reckonFlow.locator('textarea');
    if ((await textarea.count()) > 0) {
      await textarea.first().fill('feed walk reckon note');
      await reckonFlow.locator('.wizard-next').click();
    }
    await reckonFlow.locator('.wizard-submit').click();
    await viewer2.waitForTimeout(2000);
  }
  await nav(viewer2, '/');
  rows = await viewer2.locator('.event-row').allTextContents();
  if (!rows.some((t) => t.includes('round 1 reckoned — ready to complete'))) fail('round_reckoned row missing');
```

(the hoisted assert from the de-wonk fix stays OUTSIDE the flow-visible branch — a missed reckon fails loudly.)

- [ ] **Step 3: syntax check + commit**

Run: `node --check scripts/feed-walk.mjs` → clean.

```bash
git add scripts/feed-walk.mjs
git commit -m "test(walk): the round wizard is always present — no entry buttons"
```

---

## Task 7: full verification + dev server hand-back

**Files:** none expected (verification) — commit only if a fix was needed.

- [ ] **Step 1: entry-button grep gate** — `grep -rn "round-btn" client/src test-voting-browser.js scripts/feed-walk.mjs | wc -l` → 0.
- [ ] **Step 2: stop the dev server** (PID chain per /tmp/dao-dev.pid if present; kill full chains by PID; ports 9000/5173 must be free).
- [ ] **Step 3: main e2e** — `npm run build:client`; fresh DB server (`WAVEDB_PATH=/tmp/dao-4a-e2e`, background, log), `node test-voting-browser.js` → `Smoke test passed`.
- [ ] **Step 4: feed walk** — stop step-3 server, `rm -rf /tmp/dao-4a-e2e`, fresh server + `npm run dev:client`, `node scripts/feed-walk.mjs` → `FEED WALK PASSED`.
- [ ] **Step 5: gates** — `npm test` (13 suites green), `npm run typecheck:client` (0), `npm run build` (clean), `ls client/dist/wasm/crabs/` → only crabs.js + crabs.wasm.
- [ ] **Step 6: restart `npm run dev` for the user** (`nohup ... >/tmp/dao-dev.log 2>&1 & echo $! > /tmp/dao-dev.pid`, both ports listening, boot completed) and leave it running.

If a step fails: root-cause; fixes belong in the file that owns the failure (TEST-script bugs are fixable; client-src bugs = BLOCKED report with full output).

---

## Self-review notes (executed)

- Spec coverage: `completeRound` boolean (Task 1) ✓; publishFlow + stageFlowFor + no-new-shell-machinery (Task 2) ✓; always-on wizard page, no buttons, no activeFlow/watch, instance key stage@round@epoch, copy de-spined (Task 3) ✓; weights → /custodians with ids preserved (Task 4) ✓; e2e + walk retarget + grep gates (Tasks 5-6, Task 7 Step 1) ✓; verification + handback (Task 7) ✓.
- Type consistency: `stageFlowFor(stage, round): FlowDefinition | null`; `publishFlow(round)` zero-input with `ds.completeRound()` (zero-arg, Promise<boolean> from Task 1); `runRoundSpineStep(actor, flowId, note, choiceValue, afterStage)` — call sites match (Task 5 Step 2); chips selector `.round-step--current` exists in the rewritten page (Task 3 Step 1 styles) ✓.
- The `wizardKey` epoch bakes Cancel-remount; `stageResume` is consumed at mount only (shell contract) — a Cancel then stage-change double-remount is safe (props re-read once at each mount).
- The `.cols` grid has 3 columns shipped (Members/Seats/Controls); the weights Panel INSIDE `.cols` wraps to a second row — acceptable; walk decides.
- Round numbers as draft targets per slice #3 spec rule (unchanged).