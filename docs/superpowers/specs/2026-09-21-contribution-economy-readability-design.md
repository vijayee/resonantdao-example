# Contribution Economy Page Redesign — Readability & Layout

Date: 2026-09-21
Status: approved design, pending implementation plan
Base artifact: `docs/contribution-economy/` (from `docs/superpowers/specs/2026-09-16-contribution-economy-workflows-design.md`)

## Purpose

Make `docs/contribution-economy/index.html` presentable to a non-domain-expert audience:

1. Better layout, organization, and responsiveness — the current single column of 25 tall canvases requires scrolling through ~29,000px to browse.
2. All text rewritten in plain English with short, clear sentences (the source material's wording is dense and assumes domain familiarity).
3. No parentheticals in BPMN diagram box labels — qualifiers move out of the boxes entirely.

## Page structure

Sticky header: title + one-paragraph plain-English intro.
Sidebar (260px, sticky, grouped): **Overview** | **Core workflows** (3) | **Specified dimensions** (12) | **Proposed** (10). Active item highlighted; badge chips on proposed items; group headings with counts.
Main pane shows one diagram at a time: title + badge, "What happens" paragraph, "Who has to act" list, controls row (Zoom +/−, Fit, Download SVG), canvas filling remaining viewport height (floor ~500px), glossary table below the canvas.
Responsive: ≥1024px fixed sidebar; <1024px hamburger → drawer; canvas height clamped via `min(60vh, …)`; bpmn-js touch pan/zoom already works.
Style: keep dark theme; 16px base type; consistent spacing scale; hover states on nav items.

## Information architecture

Data moves out of inline `<script>` into `diagrams.json` (committed): manifest (title, badge, plain-English description, "who has to act" list) + per-diagram glossary pairs. index.html fetches `diagrams.json` plus the `.bpmn` file for the selected artifact.
Overview section content: plain-English explanation of the scoring idea ("a score per dimension, adjusted by quality, real-world outcome, verification strength, and tuning"), the anti-gaming summary, and a cross-dependency digest.

## Editorial rules

- One idea per sentence; subject-verb close together; short words over long ones.
- Verbs describe who does what to whom ("Two reviewers check the work", not "Validate crossing").
- No parentheses in box labels; qualifiers move to the glossary.
- Jargon removed from boxes entirely (`P(a)`, `N_i`, `alpha_i`, `Delta C_i`); each appears once in the Overview and in glossary rows.
- First-use glosses: balance → tally, calibration → tuning, cycle → round, outcome-verified → proof the work produced the promised result.
- Badges unchanged: "specified" / "proposed interpretation".

Box-label rewrite register (examples):

| Current | Plain English |
|---|---|
| Submit evidence: action, context, provenance, outcome | Record what happened and prove it is real |
| Review and accept artifact (Tier 2: two independent reviewers) | Two reviewers check the work |
| Delta C_i(a) = Match_i × Outcome × Verification × Calibration_i → 22 non-transferable balances | Score the action against each dimension |
| Emit explanation record (action ID, dimensions, intensities, calibration version) | Save a decision record |
| Corroboration by independent member (≥ 1) | Get a second person to confirm |
| Keep pending (settles retroactively when evidence arrives) | Leave open until evidence arrives |
| Normalize N_i(C_i) — null-preserving: null stays null, never becomes 0, never decays | Even out the tallies; blanks stay blank |

## Rename mechanics

- `rename-map.json` (committed): per diagram, pairs of `{ plain, technical }` (new box label + the name/term it replaces).
- `scripts/rename-diagrams.mjs` (committed): applies the map to `name` attributes across all 25 `.bpmn` files; idempotent; ids/flows/lanes/DI untouched. The map is also the source for the glossary tables.
- `diagrams.json` replaces the inline manifest in index.html and carries the glossary pairs for the selected diagram's card (derived from `rename-map.json`; one JSON file, no duplication).
- README: file-index one-liners and Mermaid mirrors get the plain wording; each invariant bullet gains a plain-English sibling bullet; the invariants retain their technical form first.

## Validation

1. `npm run validate` — 25 files parse clean (warnings fatal).
2. Consistency check (committed script, `npm run check-consistency`): every rename-map entry's label exists in its diagram; git diff of `.bpmn` files touches only `name=` attributes; ids/topology unchanged.
3. Browser pass: sidebar groups and switching; drawer at ~800px width; glossary tables populate; zoom/fit/download still work; zero render failures.
4. Editorial read-back: no parentheses in any box label; jargon confined to Overview and glossary rows; read-aloud check of the intro and each card description.

## Out of scope

- Restructuring diagram topology, lanes, or flows (names only).
- Rewriting the design specs/plans under `docs/superpowers/` (working documents, not the presentation surface).
- The app code in `client/`/`server/`.