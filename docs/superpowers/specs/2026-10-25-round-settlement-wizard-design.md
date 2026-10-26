# Round Settlement Wizard (Slice #4a) — Design Spec

Date: 2026-10-25 · Status: approved in brainstorm · Builds on: slice #3 wizard framework
(`2026-10-19-wizard-framework-design.md`); feeds #4b (contribution lifecycle wizards).

## Problem

The settlement spine lives on its own page as three freestanding buttons over a stage stepper —
but the design intent (Victor, 2026-10-25) was always a **wizard**: one continuous, stage-gated
flow (audit → reckon → publish), the same shell and mental model as every other wizard. Slice #3
built the vocabulary (shell, drafts, step kinds); this slice gives the spine its intended shape.

## Decisions

1. **`/round` becomes the wizard.** The route stays (nav unchanged); its content is ONE
   settlement wizard. The freestanding spine buttons (`#audit-round-btn`, `#reckon-round-btn`,
   `#complete-round-btn`) are deleted — the wizard is always present.
2. **No new shell machinery.** The slice #3 shell is used VERBATIM (no new step kinds, no shell
   gating mode). Instead, the host page composes: the round's **stage** selects which
   FlowDefinition the wizard renders — audit steps at `STAGE_OPEN`, reckon steps at
   `STAGE_AUDITED`, publish review at `STAGE_RECKONED`. The page's existing stage stepper
   (Open/Audited/Reckoned/Published chips) renders ABOVE the wizard as the pipeline view:
   reachable steps show as it does today; stage transitions come from any member's op (own or
   remote), and the slice #3 `watch(stage, …)` close-guard keeps an open flow honest when a
   remote op advances past it.
3. **Weights panel → `/custodians`.** Custodian-scoped control is exactly custodian-page
   content; `RoundPage`'s weights Panel (alpha inputs + set-calibration button) moves there,
   verbatim behavior (`setRctAlpha`, `setCalibrationVersion`), gated by `ds.isCustodian`.
4. **Drafts** reuse the slice #3 rule unchanged: persist from the first committed step, keyed
   `wizard-draft/{username}/{flowId}/{roundNumber}`, cleared on cancel/completion. A draft saved
   on round N is simply absent on round N+1 (target key changes).
5. **No dedicated page content besides the wizard**: the round explanations record
   (`getRoundRecords` notes — e.g. "audit: …" lines) render as a muted context block under the
   wizard card; they are the spine's own permanent record and stay visible at every stage.

## Architecture

### Flow definitions (`client/src/wizard/flows/round-flows.ts` — extended)

Three per-round factories (the existing `auditFlow`/`reckonFlow` stay; one new):

- `auditFlow(round)` — as shipped in slice #3 (choice Fair/Unfair + note + review).
- `reckonFlow(round)` — as shipped (note + review).
- `publishFlow(round)` — NEW: zero-input flow — steps `[review]`; the review summary renders
  the aggregation preview: count of the current round's accepted contributions (from the dao
  mirror, tick-gated) and, when it is **0**, a visible plain warning ("nothing settled to
  aggregate — publishing records an empty round") so the old snap-error guard becomes displayed
  state. Submit → `ds.completeRound()`.

### Store

- `completeRound` gains the same `Promise<boolean>` contract as its five slice #3 siblings
  (guards `return false` with status messages unchanged — "Nothing settled to aggregate in this
  round." stays; success `return true`; catch `false`). Signature stays zero-arg.
- No other store changes.

### Page (`client/src/components/round/RoundPage.vue` — rewritten)

- `SectionHeading` keeps the round context but the user-visible copy drops the spine metaphor:
  title **"The settlement cycle"** (lede updated to describe the cycle in plain terms; C_-codes
  live in code comments/docs, not the heading).
- Body = the stage chips + `<WizardFlow :key="activeFlowKey(stage, round)">` with the stage-matched
  factory + resume draft wiring (`stageFlow(stage, round)` mapping STAGE → factory), round
  number as `targetId`, then the explanations block.
- NO `activeFlow` state exists — the wizard is always mounted; its content derives from the
  stage. A stage or round change produces a fresh instance naturally (instance key
  `stageId@round` — slice #3's stale-initial insurance), which also retires the slice #3
  stage-close `watch(stage, …)` (there is nothing left to close). A mid-flight draft for a stage
  that has passed is simply not offered again for the rest of that round.

### e2e / walk fallout

- `test-voting-browser.js`: `runRoundSpineStep` retargets — the wizard is always on `/round`;
  drive the current stage's flow per stage (audit choiceValue 'fair'/note, reckon note, publish
  straight-submit); wait condition becomes the stage chip flip (`.round-step--current` moving to
  the next stage) instead of a button appearing.
- `scripts/feed-walk.mjs`: audit + reckon sections drive the always-present wizard (same
  selectors as slice #3 minus the entry-button clicks).
- `completeFlow` needs no change: it already drives "from the current step" per flow.

## Testing

- Jest: no shared-source changes (the flow factories are client data + the store op contract is
  unchanged in shape); suites stay green.
- Both e2e drivers updated per above; gates unchanged (jest, typecheck, build, devtools-leak,
  main e2e, feed walk). The e2e's spine section remains the proof that the full cycle closes:
  audit → reckon → publish with acceptance aggregation.