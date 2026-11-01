# Contribution Lifecycle Wizard (Slice #4b) — Design Spec

Date: 2026-11-01 · Status: approved in brainstorm · Builds on: slice #3 wizard framework
(`2026-10-19-wizard-framework-design.md`), slice #4a round settlement wizard
(`2026-10-25-round-settlement-wizard-design.md`), domain wizard model
(`2026-10-03-contribution-wizard-data-design.md`).

## Problem

A contribution's whole life — submission, per-schema verification, settlement, appeal — should be
ONE wizard (multiple users act in the same flow at their turn), never a stack of per-action
dialogs or buttons. Slice #3 built the engine vocabulary and mini flows; slice #4a proved the
always-present pattern. This slice makes each contribution a **linkable page whose lifecycle
wizard IS the surface**, with the engine gaining native turn-taking.

## Decisions

1. **Engine gains a lifecycle mode** (Victor chose the deeper substrate over page-assembly):
   `LifecycleWizard.vue` renders turn-taking phases natively — done phases (recorded who/when),
   the current phase (form embedded when it's YOUR turn), locked future phases — and reuses the
   slice #3 mini-flows (verify/settle/appeal factories) as the per-turn forms, so every op still
   rides the tested validation/draft/error machinery.
2. **The facts adapter stays `wizardModel`** — the engine consumes its projection
   (phases/actors/mayAct/progress); domain lifecycle rules are NOT reimplemented inside the
   engine (that projection is jest-covered and single-source).
3. **Per-contribution routes**: `/contribute/:contributionId` (lifecycle page) and
   `/contribute/new` (the submit wizard). The /contribute list becomes slim linked rows.
4. **Participant blocking (page-level)**: participants = submitter + anyone holding an
   actionable role on any schema step + anyone who already acted + custodians. Non-participants
   get a one-line denial on the page; the list filters its rows per viewer; the feed band stays
   consistent (it already gates actionability by mayAct). HONEST SCOPE: this is a UI boundary —
   replicated op-log bytes remain members-visible (devtools/raw log); ledger-level privacy is a
   separate future project, documented as such.
5. **Cards lose their action buttons** — all action happens on the contribution page.

## Architecture

### Engine: lifecycle mode (`client/src/wizard/lifecycle.ts`, `LifecycleWizard.vue`)

```ts
export interface LifecyclePhase {
  stepId: string;
  title: string;
  state: 'done' | 'current' | 'locked';
  doneBy?: string;           // recorded actor
  doneAt?: number;           // recorded op time (ms epoch)
  progress?: { done: number; required: number };   // e.g. verification (1/2)
  mayAct: boolean;           // viewer can act NOW
  waitingOn?: string;        // role-based turn text ('awaiting a verification', 'awaiting the submitter') — the domain does NOT know which eligible member will act; never a member name
  note?: string;             // recorded verdict/reason summary for display on done phases
  flow?: FlowDefinition;     // the actionable form for the CURRENT phase (when mayAct)
}

export interface LifecycleModel {
  contributionId: string;
  summary: string;
  submitter: string;
  outcome: 'pending' | 'accepted' | 'rejected';   // terminal banner on the page
  appealed: boolean;
  phases: LifecyclePhase[];
}
```

- `lifecycle.ts` provides `lifecycleModel(entry, viewer, viewerIsCustodian): LifecycleModel`
  — a pure projection over the contribution mirror + `wizardModel` (reuses its facts plumbing:
  schemaForDims, step done counts, roles) + turn annotations resolved from the feed mirror
  (`ds.feedEvents()` carries contributor-op timestamps; verifiedBy/verdictReason/harm come from
  the existing accessors). Annotations DEGRADE GRACEFULLY: a done phase whose contributing event
  has aged out of the capped feed mirror renders without the who/when line rather than inventing
  one. Jest-covered in `server/test/lifecycle.test.ts` (TDD; pure function,
  MockNode/State helpers as in wizard.test.ts).
- `LifecycleWizard.vue`: renders the phase rail (done chips with who/when, current chip, locked
  chips), the waiting states, the terminal/outcome banner, and when the current phase's
  `mayAct` holds, embeds `<WizardFlow :flow="phase.flow" ...>` for that one turn. No new op
  mechanics — it mounts the same mini-flow the cards used, in the page.

### Submit wizard (`/contribute/new`)

- A linear `WizardFlow` with steps: **dimension choice** (radios from `DIMENSIONS`), **summary**
  (text), **evidence** (NEW step kind below), **review** (dim label + summary + evidence line).
- Submit → `ds.submitContribution(summary, dim, evidenceFile, evidenceText)` (the existing dual
  path: file → content store; pointer → text) → on success `router.push(/contribute/<id>)` → the
  lifecycle page takes over (facts-driven from there).
- The submit wizard runs at a route WITHOUT an id, so its draft key uses flowId 'contribute-new'
  and targetId 'new' (draft rules otherwise unchanged; only first-committed-step persistence).
- New shell step kind `evidence`: renders pointer text input + file input (either-or, both
  optional per today's rule); validation: no requirement (optional step) — but the summary step
  keeps its required rule. The FILE cannot live in a draft: drafts persist the serializable
  answers only (dim, summary, pointer); on resume the file input re-attaches with a notice line
  in the step ("the file was not kept in the draft — re-attach it"). The evidence step's answer
  object carries `{ pointer: string; fileName?: string }`; the File object itself rides
  component state, excluded from drafts.

### Routes & pages

- **`/contribute/:contributionId`** — `ContributionPage.vue`: header (summary + status pill +
  dim + submitter), `LifecycleWizard`, evidence display (existing loader behavior moves here:
  content:// fetch/download renders as today's card evidence block), verdict line, harm
  receipt. Non-participant: one-line denial ("You're not part of this contribution."). Unknown
  id: "Unknown contribution." read-only page. Read-only for terminal contributions (full
  recorded history still renders — the page doubles as the permanent record).
- **`/contribute`** — list page: "New contribution" entry (→ /contribute/new) + slim rows
  (title, dims, status pill, evidence label, `open →` link). Rows FILTERED per viewer to
  participant-visible entries (decision 4).

### Deaths

- ContributePage's submit form panel + one-at-a-time/activeFlow/sweep machinery.
- ContributionCard's action buttons, per-card wizard hosting + CardAction machinery; the card
  component retires entirely (its remaining display duties move to ContributionPage; the list
  row renders from the mirror directly). 
- `clickInCard` and the armDialogs-era card-click retry patterns in the e2e.

### Survivors (untouched)

- `WizardFlow.vue`, `types.ts` (linear mode + the new evidence kind), `drafts.ts`, the five
  linear flow factories, the round settlement wizard (#4a) + round factory/flows, feed page,
  `wizardModel`.

### Error & edge states

- The mini-flows' store guards remain authoritative (reciprocity, ownership, submitting lock);
  their rejections surface in the flow's error panel + status pill exactly as today.
- A draft resumed on a phase whose turn has PASSED (facts moved on, e.g. someone else verified
  while your verify draft sat): the phase re-derives from facts (mayAct false) → the waiting
  state renders and the stale draft is dropped silently by the lifecycle composition (the
  mini-flow's own draft cleanup rule does not fire — the page simply doesn't mount it).
- Two tabs, same user: last-writer-wins drafts, same as slice #3.

### e2e / verification fallout

- `submitContribution(submitter, dimValue, summary)` helper → drives `/contribute/new` + pushes
  its route change, returns the id from the URL.
- Verify/settle/appeal helpers → navigate to `/contribute/:id` (rows link / explicit route) and
  drive the embedded flow; the card-click retry machinery is replaced by page-scoped driving.
- `scripts/feed-walk.mjs` untouched (it audits only); gates unchanged; jest grows the
  lifecycle.test.ts suite.

## Testing

- Jest (TDD): `server/test/lifecycle.test.ts` — pure `lifecycleModel` tests: phase states from
  facts (pending/verified-1-of-2/terminal), mayAct per role (verifier/submitter/custodian),
  turn annotations (waitingOn from mirror), appeal rendering, read-only/unknown-schema rule,
  PARTICIPANT rule (submitter + mayAct-any-step + already-acted + custodian).
- e2e: main run drives the new-contribution wizard + per-page verify/settle/appeal/round-spine;
  feed walk unchanged; gates as usual (jest, typecheck, build, devtools-leak, dev server
  hand-back).