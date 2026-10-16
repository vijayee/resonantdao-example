# Frontend Re-platform: Vue 3 + resonantos.com Design System — Design (Slice #1)

Date: 2026-10-16
Status: approved design, pending implementation plan
Parent effort: UI overhaul decomposition (five slices; this is slice #1)

## Program context

The UI overhaul request decomposes into five sub-projects, each with its own
spec → plan → implementation cycle:

1. **Frontend re-platform + design system** (this slice) — Vue 3 rebuild of the
   presentation layer, styled after resonantos.com.
2. **Feed page** — informational/navigation hub replacing the multipurpose
   dashboard; no forms.
3. **Wizard framework** — generic multi-step wizard substrate wired to feature
   forms (proposal, election, round, custodian admin).
4. **Contribution wizard substrate** — dimension-aware step modules keyed off
   the 22-dimension registry (`shared/src/contribution.ts`), swapping in/out per
   selected dimension; ships with the working dimensions (C_1/C_2/C_18), the
   other 19 drop in later.
5. **Account page** — financial-app breakdown: token balance, per-dimension
   tallies, ledger history.

Dependency order: this slice first → feed → wizard framework → contribution
substrate; account page after the feed. Later slices must target the shell,
routes, and components built here without retrofits.

### Design decisions (locked 2026-10-16)

- **D1 — Framework: Vue 3 + SFC.** `<script setup lang="ts">` single-file
  components, `vue-router`, `pinia`. Rationale: reactivity maps directly onto
  the form/data-collection UI; SFCs keep each future wizard step (and
  dimension step module) as one self-contained file. The project remains on
  the existing Vite build.
- **D2 — Big-bang re-platform.** Slice #1 re-platforms all existing dashboard
  features into Vue components rather than keeping the legacy dashboard alive
  under a strangler adapter. Legacy `ui.ts` (1,631 lines) and the old
  dashboard markup are deleted in this slice.
- **D3 — Adoption depth: tokens + motifs.** Port resonantos.com's palette,
  typography, panels, buttons, inputs — plus signature motifs where they serve
  the app (numbered section labels, ✓/✕ verdict columns, eyebrow kickers,
  gradient panel fills). No marquee, no radial diagrams, no landing-page
  devices.
- **D4 — Both themes.** Dark is default; the light theme ships from day one
  behind the header `data-theme` toggle. Every component is built against both
  token blocks.
- **D5 — Self-hosted fonts.** Fraunces (display), Space Grotesk (body),
  IBM Plex Mono (data) as woff2 files under `client/public/fonts/`. No Google
  Fonts CDN dependency.
- **D6 — CRABS devtools in dev mode only.** The devtools-enabled wasm artifact
  plus the `bindings/devtools` inspector attach to the browser node whenever
  not in a production release, gated by Vite's `import.meta.env.DEV`.

## Architecture & routing

Purely presentation-layer rebuild: `server/`, `shared/src/*`,
`client/src/dao.ts`, the wasm wrappers (`crabs-wasm-wrapper.ts`,
`eauth-wasm-wrapper.ts`), `client/src/eauth-wallet.ts`,
`client/src/server-client.ts`, and `client/src/storage.ts` are functionally
untouched.

**Stack additions**: `vue@3`, `vue-router`, `pinia` (client dependencies).

Each current dashboard section card becomes its own route page:

| Route | Page | Existing content re-plated | Later slice |
| --- | --- | --- | --- |
| `/` | Feed placeholder (hub comes in slice #2) + quick links | — | #2 real feed |
| `/proposals` | Proposal list + create form | proposal form/list cards, vote controls | #3 create → wizard |
| `/elections` | Custodian election + ballot | election card, election area | #3 lifecycle → wizard |
| `/contribute` | Contribution submit + verify/harm flows | contribute card, contributions list | #3/#4 wizard substrate |
| `/round` | Round spine panel | round stepper, audit/reckon/complete, alpha + calibration forms | #3 close-round wizard |
| `/custodians` | Members + custodian admin | members sidebar, custodian controls card | — |
| `/account` | Placeholder | — | #5 real page |

Nav in the header links all seven. Placeholder pages carry the full design
language so the shell is visually complete while content stays honest.

Stable DOM ids from the current markup (`#proposals`, `#election-area`,
`#round-stepper`, …) are preserved across the port to minimize churn in
`test-voting-browser.js`.

Auth is the pre-route stage: an `AuthView.vue` rendered before routes resolve,
guarded by an auth-ready/session check in the router.

Round semantics reference (what the Round page drives): a round is the
settlement cycle of the contribution economy — a three-step spine
(C_10 audit → C_20 reckon → C_21 complete/publish, `shared/src/round.ts`),
driven by any member; completion aggregates `alpha_i × N_i(tally_i)` per
member and publishes `$RCT` summaries. See
`docs/superpowers/specs/2026-10-06-round-spine-rct-aggregation-design.md`.

## Design system

### Tokens (`client/src/design/tokens.css`)
Port both theme blocks from resonantos.com's inline CSS verbatim as the single
source of truth.

- **Dark (default)**: bg `#0c1f15`, ink `#e4efe4`, muted `#8fae97`, faint
  `#5d7f6c`, jade accent `#5fd0a0` (hover `#8fe0b8`), amber secondary
  `#e8a84c`, line `rgba(95,208,160,.16)`, panel `rgba(22,46,34,.72)`,
  gradient card `linear-gradient(160deg, jade-alpha, amber-alpha)`,
  grid-line `rgba(95,208,160,.05)`.
- **Light** (`[data-theme="light"]`): bg `#f7f4ea`, ink `#1c3a2c`, jade
  `#0f7a56`, amber `#a8690f`, white-glass panels.
- Theme selection lives on `<html data-theme=…>`; default dark.
  `useTheme()` composable persists to localStorage, defaults to
  `prefers-color-scheme`, exposes a segmented toggle in the header.

### Typography
- Fraunces (variable, `opsz 9..144`, weights 300/400 + italic 300) — display:
  page titles, wordmark, serif emphasis inside headings.
- Space Grotesk (400/500/600) — body/UI text.
- IBM Plex Mono (400/500) — all data surfaces: balances, register values,
  ids, HLC stamps, operation payloads.
- Self-hosted woff2 under `client/public/fonts/`; `@font-face` in
  `base.css`. A `scripts/fetch-fonts.sh` fetches the files once during
  implementation — Fraunces and Space Grotesk as single variable-font files,
  IBM Plex Mono as 400/500 statics (falls back to system stacks if the
  network refuses, and must be retried before merge).

### Base layer (`client/src/design/base.css`)
Resets, focus-visible rules, selection styling, `body::before` grid-line
overlay, eyebrow/section-number utilities, typography scale.

### Motif components (`client/src/design/components/`)
- `SectionHeading` — eyebrow kicker + numbered `01` ordinal + Fraunces title
  with `em`/glow accent; used on every page header.
- `VerdictSplit` — ✓/✕ two-column comparison for accept/reject content
  (harm receipts, verification outcomes, election results).
- `Panel` — glass/gradient card, with a numbered variant.
- `Pill` — state badges (pending/accepted/rejected/appealed and friends);
  amber for caution/harm, jade for success.
- `NumLabel` — large translucent numerals for step indicators; seeds the
  wizard step chrome of slice #3.

The CRABS devtools panel keeps its own light "soft & friendly" look by design
— a debug tool, outside the product design system.

## Components & state decomposition

```
client/src/
  design/                          # tokens.css, base.css, components/, use-theme
  app/
    App.vue                        # shell: header (brand, nav links, theme toggle,
                                   #   user chip, token balance, logout), router-view,
                                   #   footer, status bar mount
    router.ts                      # routes from §Routing + auth route guard
  stores/
    auth.ts   (pinia)              # register/login/logout session state
    dao.ts    (pinia)              # owns BrowserDao lifecycle; reactive snapshot;
                                   #   Node.create + devtools attach point
    status.ts (pinia)              # global status bar text/kind — the setStatus path
  components/
    auth/AuthView.vue
    proposals/  ProposalsPage, ProposalCard, ProposalForm, VoteControls
    elections/  ElectionsPage + ballot/result subcomponents
    contribute/ ContributePage, ContributionForm, ContributionCard, RoundStepper
    round/      RoundPage (stepper, audit/reckon/complete, alpha/calibration)
    custodians/ CustodiansPage, MemberList, CustodianControls
    feed/       FeedPlaceholder  /account/ AccountPlaceholder
    status/     StatusBar
```

**Mapping rule**: each `render*` function of the current `AppUI` god-class
becomes a template + computed properties; each event-handler body becomes a
component method or store action. Status-bar strings and error messages port
verbatim.

**Behavioral parity rule**: every feature handler in the current `ui.ts` must
exist in the Vue tree firing identical requests to the server (op names,
payload shapes, endpoint calls). Parity is the gate, verified by the Playwright
run.

**Interim honesty**: the proposal-create, contribution-submit, and
alpha/calibration forms remain forms in this slice; they become wizard
substrate in slices #3/#4, and pages are built to accept a wizard component in
the same slot.

**Uncommitted work absorbed**: the in-progress username-invisible-chars fix in
`client/src/ui.ts` ports into `AuthView.vue` and ships with this slice.

## CRABS devtools (dev-only)

- `scripts/copy-wasm.sh` gains an artifact-set argument: the dev path also
  copies `crabs.dev.js`, `crabs.dev.wasm`, and `bindings/devtools/{devtools-api.js,
  crabs-devtools.js}`; the prod path (used by `build:client`) copies only the
  production set. Dev artifacts go to a non-public directory served only by the
  dev server so `publicDir` copying cannot leak them into `dist/`; the plan
  verifies the Vite root/publicDir config and the dev-server asset path before
  finalizing the directory.
- `main.ts` boot (dev only): inject the dev wasm script + the two devtools
  scripts before the wrapper initializes. The wrapper prefers
  `window.createCRABSModuleDev` when present under `DEV`.
- `stores/dao.ts`: in dev, `CRABSDevtools.attach(node, { nodeId })` after
  `Node.create`; multiple nodes share the one overlay panel with a selector.
- Safety: the devtools snapshot exposes plaintext CRDT state, so it must never
  ship in a production release. Gates: absent artifact in prod copy mode +
  `import.meta.env.DEV` guard + the production wasm throws if a dev binding
  attempts devtools access. `vite build` must produce a bundle with no
  devtools references (asserted in the plan's verification step).

## Testing & verification

- **Server/jest suites** — untouched and green: they are the API-contract
  regression backstop (op types, payload shapes unchanged).
- **Playwright browser test** (`test-voting-browser.js`) — selectors updated to
  the new pages; the full flow (register → login → propose → vote → contribute
  → verify) must pass end-to-end across routes.
- **Manual dev-server pass** — walk every route in both themes at one narrow
  viewport; exercise each re-plated feature; eyeball fonts/tokens/motifs.
- **Build gate** — `npm run build` (server + client) clean; prod bundle
  contains no devtools artifacts.

## Rollout ordering

1. Fetch fonts; write `tokens.css`, `base.css`, design components (no behavior).
2. Vue shell: `App.vue`, `router.ts`, the three stores, `AuthView.vue` port.
3. Re-platform feature pages in dependency order: Proposals → Elections →
   Contribute → Round → Custodians; then delete legacy `ui.ts` and the old
   dashboard markup from `index.html`.
4. Devtools wiring: copy-wasm modes, dev script injection, `dao.ts` attach.
5. Playwright selector updates; parity run; `npm test` + builds.

## Risks

- **Behavioral drift** in re-platforming ~1,631 lines of imperative handlers —
  mitigated by the behavioral-parity rule and the Playwright end-to-end gate.
- **Font download failure** during implementation — self-hosted so no runtime
  CDN dependency; fallback stacks documented, retry required before merge.
- **Devtools leak into prod** — structurally gated three ways (copy mode,
  DEV env guard, production wasm refusing dev binding attach); asserted at
  build time.
- **Stable-id drift** breaking the Playwright test — ids preserved per §Routing.