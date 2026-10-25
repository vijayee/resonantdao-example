# Wizard Framework (Slice #3) + Settlement-Spine Flows — Design Spec

Date: 2026-10-19 · Status: approved in brainstorm · Predecessors: slice #1 re-platform
(`2026-10-16-frontend-replatform-design.md`), slice #2 feed
(`2026-10-17-feed-page-design.md`), domain wizard model (`2026-10-03-contribution-wizard-data-design.md`).

## Problem

The settlement spine drives the operator through browser-native `confirm()`/`prompt()` dialogs —
7 call sites in `client/src/stores/dao.ts` (verify choice :390, verify reason :403, settle note
:437, appeal reason :465, audit fair?+note :494-5, reckon note :522). These block the page, can't
be styled, and carry semantics in modal traps (`OK = fair, Cancel = UNFAIR`). Slice #3 was planned
as a wizard framework anyway; this makes the settlement spine its first consumer, so the
framework is validated against real flows before slice #4's 22-dimension contribution wizard
arrives.

## Decisions (from brainstorm)

1. **Guided wizards replace all 7 dialogs** — verify, settle, appeal (Contribute page), audit,
   reckon (Round page). No browser dialogs remain in `client/src` after this slice.
2. **Hosting is in-place**: the flow renders replacing the entry card / action button clicked,
   inside the host page. No new routes. One wizard open at a time per page.
3. **Framework shape is declarative flows + one generic shell** — flows are TS data objects;
   `WizardFlow.vue` renders steps, handles validation/navigation/drafts/submit. No per-flow
   components.
4. **Drafts persist from the first committed step** (each step advanced *past* is committed) and
   live in localStorage **indefinitely until completed or explicitly Cancelled**. Before any step
   is committed, abandoning loses nothing (same as a canceled prompt today). Drafts whose target
   has gone terminal/stale are dropped when the host page next enumerates them.

## Architecture

### Framework (`client/src/wizard/`)

**`types.ts` — flow definitions (pure data):**

```ts
type FlowStep =
  | { kind: 'choice'; id: string; title: string;
      options: Array<{ value: string; label: string; desc?: string }> }   // single-select, required
  | { kind: 'text'; id: string; title: string; placeholder?: string }     // multiline, non-empty required
  | { kind: 'review' };                                                   // always last; validated by the shell

interface FlowDefinition {
  id: string;          // 'verify' | 'settle' | 'appeal' | 'audit' | 'reckon' — part of the draft key
  title: string;       // rendered in the wizard card header
  steps: FlowStep[];
  submit(answers: Record<string, string>): Promise<void>;  // calls the store op; throws → shell shows error
}
```

Validation is fixed by the shell (not per-flow): a choice requires exactly one selection; text
requires non-empty after trim. All five current flows want exactly these rules — the store's
existing checks are the source of truth, unchanged.

**`WizardFlow.vue` — the generic shell** (props: `flow`, optional `initialAnswers`; emits
`close`): step-dot progress rail (`Decide → Reason → Review`), Back across committed steps
(answers preserved; re-advancing overwrites), Next validates the current step, final step is
Review with the submit button (disabled while `submitting`), inline red error panel on submit
failure (draft NOT cleared — retry keeps answers), Cancel → delete draft, emit close, entry card
returns.

**`drafts.ts` — draft store** (localStorage, username-scoped):
Key `wizard-draft/{username}/{flowId}/{targetId}`, value `{ answers, stepIndex, savedAt }`.
Written only once ≥1 step is committed; deleted on completed submit or explicit Cancel; a draft
enumerated by a host page whose flow can no longer act (target terminal, stage moved) is dropped
without ceremony (the host page simply no longer offers them). Reasons are recorded-permanently
material once submitted — before that they stay local-only; no draft content is sent to the
server or included in snapshots.

### Flows (`client/src/wizard/flows/`)

- `contribute-flows.ts`: `verifyFlow(entry)` — choice step
  Uphold / Uphold, harm reduced / Void / Reject (descriptions carry today's prompt wording, e.g.
  reduced harm: "counts at reduced weight per the settlement scale"), then text reason
  ("recorded permanently"), then review+submit → `ds.verifyContribution(entry, { choice, reason })`.
  `settleFlow(entry)` — text note → review. `appealFlow(entry)` — text reason → review.
- `round-flows.ts`: `auditFlow()` — choice Fair / Unfair (**replacing** the OK=FAIR / Cancel=UNFAIR
  trap; Unfair's description carries "records the round debt and skips aggregation") → text note →
  review. `reckonFlow()` — text note → review. Round flows have no entry id; their draft target
  is the **current round number** (so a draft saved on round N resumes for round N only — by the
  time round N+1 opens, the host page no longer enumerates it).

The five verify outcomes map to today's exact semantics: yes → pass, yes-harm → pass+harm
'reduced', voided → pass+harm 'voided', no → fail. Nothing changes server-side.

### Store refactor (`client/src/stores/dao.ts`)

The five dialog-based functions become typed-parameter actions with the dialogs removed
(e.g. `verifyContribution(entry: ContributionMirrorEntry, input: { choice: string; reason: string })`).
Guard checks stay in the store and reject via the status store (reciprocity
(:384), ownership (:436/:464), submitting lock, round stage checks); the host page consults the
same public conditions when deciding whether to offer a flow's entry, but the store remains the
authoritative gate on submit. Payload details (`priorVerifiers`, `priorHarm`,
`calibrationVersion`) stay computed inside the store.

### Host pages

- `ContributePage.vue`: each verify/settle/appeal entry card can host its flow; clicking mounts
  `WizardFlow` in the card's place; a stored draft renders the card with a "Draft — resume"
  affordance (resume opens at the saved step).
- `RoundPage.vue`: audit/reckon buttons become flows in place, same mechanics, same resume affordance.

### e2e / verification

- `test-voting-browser.js` loses its dialog-answering contract (`armDialogs` deleted) and drives
  the wizards directly (fill/click per step) — it gains real coverage of reason entry, which the
  prompt path previously filled with canned responses.
- `scripts/feed-walk.mjs`'s audit confirm/prompt handling becomes wizard clicks.
- Gates unchanged: jest suites, `typecheck:client`, `build`, prod devtools-leak assert, main e2e,
  feed walk.

## Error handling

- Store guards fire before submit and surface a status-store message; the wizard stays open so
  the user can cancel or the situation can change.
- Submit failures (op_rejected / network) render inline in the Review step; the draft survives.
- Draft resume never auto-submits; it lands on the saved step with answers restored.

## Testing

- Jest: nothing server-side changes (store refactor is client-only); flow definitions are plain
  data — covered by the e2e walks, not unit tests.
- Headless: the two walks cover verify (bogus + valid), audit, and the dialog-free assertion.
- A grep gate — `prompt(`/`confirm(`/`alert(` must return nothing in `client/src` — is part of the
  slice's manual verification pass, keeping dialogs from creeping back.