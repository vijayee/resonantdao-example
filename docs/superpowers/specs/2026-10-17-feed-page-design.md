# Feed Page — Design (Slice #2)

Date: 2026-10-17
Status: approved design, pending implementation plan
Parent effort: UI overhaul decomposition (slice #1 shipped: Vue 3 re-platform + resonantos design system, spec 2026-10-16-frontend-replatform-design.md)
Data source decision: **Approach A** — capture at `BrowserDao.executeRemote`, plus the native CRABS change-callback for push reactivity.

## Purpose

Replace the placeholder feed at `/` with the real informational/navigation hub.
Its only purpose is to **inform and direct**: what is happening in the DAO, and
where to go to act on it. No forms, no op-signing, no prompts — every feature
has its own page (and from slice #3, its own wizard).

## Decisions (locked 2026-10-17)

- **D1 — Shape:** an actionable band ("Needs your attention") above a unified
  chronological activity stream ("Recent activity"). Both were requested
  together; the band prioritizes effort, the stream tells the story.
- **D2 — Timeline scope: consequential ops only.** Proposals created/executed,
  contributions submitted/verified/settled/appealed, elections
  started/finalized, round spine steps + publications. Individual votes are
  NOT mirrored — votes stay invisible in the feed.
- **D3 — History:** newest first, 50 rendered, expandable up to the in-memory
  200-event cap ("show older"). Each item notes its round where relevant.
  Empty state: the DAO has been quiet.
- **D4 — The feed is home.** After login/registration the router lands on `/`.
- **D5 — Data capture (Approach A):** one capture point inside
  `BrowserDao.executeRemote` (after the existing mirrors) builds the feed
  events; every op — login replay, server broadcast, own submits — passes
  through exactly once, so the timeline is complete and deduplicated.
- **D6 — Native change-callback for reactivity.** CRABS raises change events
  on every mutation (`state_notify_change`, `src/StateMachine/state_machine.c`);
  the wasm bindings expose them via `node.on('change', listener)` returning an
  unsubscribe function (`bindings-core.js:1079`). Our vendored wrapper lacks
  `on/off` (derived from production `index.js`) and is resynced with
  upstream's `on/off` + trampoline block. `BrowserDao` subscribes once at
  `init()`; each notification bumps the dao store so ALL UI updates become
  push-based — eliminating the "forgot `void ds.tick`" stale-computed bug
  class found twice in slice #1 reviews/e2e. The 1 s demo clock remains only
  to advance the `time_now` register (countdown timers). Trust note observed:
  the listener never mutates node state.

## Data layer

### FeedEvent model (in `client/src/dao.ts`, beside the existing mirrors)

```ts
export interface FeedEvent {
  index: number;       // capture sequence (op-log order; monotonic per session)
  type: 'proposal_created' | 'proposal_executed'
      | 'contribution_submitted' | 'contribution_verified'
      | 'contribution_settled' | 'contribution_appealed'
      | 'election_started' | 'election_finalized'
      | 'round_audited' | 'round_reckoned' | 'round_published';
  actor: string;       // op.signerId
  at: number;          // node time_now at execution
  round: number;       // round:current at execution
  summary: string;     // pre-rendered plain text: '"Fix the roof" — direct proposal created'
  targetId?: string;   // proposalId / contributionId / electionId — deep-linking
  detail?: {           // per-type fragments (type/harm/pass as applicable)
    proposalType?: 'direct' | 'quadratic';
    verifyPass?: boolean;
    harm?: HarmVerdict;
    fair?: boolean;
    aggregatedCount?: number;
  };
}
```

### Capture (`mirrorFeedEvent(op)` inside `executeRemote`, after the existing mirrors)

- Parses the payload per type from the op's bytes (same readback pattern the
  other mirrors use). Timestamps come from the node's `time_now`/`round:current`
  registers at capture time.
- Builds `summary` strings from payload fields only (titles, usernames,
  harm verdicts) — plain text, templated into textContent, never raw HTML
  (no injection surface).
- Unknown/unsupported payload shapes degrade to a generic summary for that
  type (schema-version tolerance, mirroring the contribution card's
  `readOnly` behavior).
- Events unshift into a `feedEvents` array capped at 200 in memory.
- Accessor: `getFeedEvents(): FeedEvent[]`.

### Change-callback resync + subscription

- `client/src/crabs-wasm-wrapper.ts`: port upstream `Node.on/off('change')`
  plus the trampoline registry helpers (upstream `bindings-core.js:20-90`,
  `1077-1099`) — small, matches the `getUser` resync precedent (commit
  2041da8). The file remains `@ts-nocheck`'d vendored material.
- `BrowserDao.init()`: `node.on('change', handler)`; the handler forwards the
  raw event (`{kind, type, signer, node, target, preview, result}`) to an
  `onChange` callback registered by the dao store. The store maps any
  notification to `bump()` (push-based reactivity for every page).
- The C event struct carries lamport/HLC stamps but the wasm JSON bridge
  serializes only `{kind, type, uuid, signer, node, target, preview, result}`
  (`src/Util/wasm_helpers.c:93`) — timestamps are stamped at capture instead.
  Ordering authority remains the HLC (`ordering: 'hlc'`); `time_now` gives the
  wall clock.

### Store plumbing

`useDaoStore` gains: `feedEvents()` (tick-gated read of
`dao.value.getFeedEvents()`), the change-hook wiring inside `bootstrap()`
(subscribes/tears down with the dao), and nothing else — no new op actions,
no server changes.

## Feed page (`client/src/components/feed/`)

- `FeedPage.vue` — composition: SectionHeading (`00 / The feed`), the
  actionable band, the timeline.
- `NeedsAttention.vue` — "Needs your attention" band; jade-bordered panels in
  a two-column grid; empty state "You're all caught up." Projections (all
  tick-gated computeds, reusing existing dao accessors and `wizardModel`
  role checks — no new rules):
  - open, unexecuted, unexpired proposals the viewer hasn't voted on → `/proposals`;
  - pending contributions whose current step lets the viewer act (the same
    `roles[actor].mayAct` logic the contribution cards use) → `/contribute`;
  - open, unfinalized elections the viewer hasn't voted in → `/elections`;
  - a round stage the viewer may advance (spine policies are
    member-or-custodian) → `/round`.
- `FeedTimeline.vue` + `FeedEventRow.vue` — the stream: newest-first capped
  at 50 with "show older"; each row is a `RouterLink` to the owning page
  (proposal → `/proposals`, contribution → `/contribute`, spine/publication →
  `/round`) carrying the mono timestamp, actor, summary, and a `Round N` chip.
  Type-ordered glyph accents (✦ style).

All four components are pure presentation over store accessors.

## Routing & landing

- Auth store success paths now push `/` (feed).
- Router guard unchanged (unauthenticated users see only the feed placeholder
  state — once landed, the unauthenticated feed renders the static
  inform/direct content without member data).
- e2e (`test-voting-browser.js`): after each `runUser`, the flow navigates
  explicitly to `/proposals` before creating proposals; no other changes —
  all page-acts already navigate to their routes. The unauthenticated feed
  page must not crash on missing dao state (guards around accessors).

## Testing & verification

- **Browser walk** (headless Playwright, fresh DB): register → feed renders;
  create proposal → timeline gains `proposal_created` with correct actor/round;
  second-page verify/settle → rows appear; spine close → `round_published`
  and the band clears to "all caught up"; votes never appear; "show older"
  reveals earlier items.
- **jest suites** untouched and green (142/142) — server contract unchanged.
- **Gates**: `npm run typecheck:client` (0 errors), `npm run build`, prod
  devtools-leak assert — as in slice #1.

## Risks

- **Mirror drift** on new op types — new consequential types must be added to
  the capture list; unknown types degrade gracefully (no crash), so drift is
  visible, not fatal.
- **Replay cost** — the mirror parses one payload per op during login replay;
  bounded by the 200-event cap and the existing replay cost.
- **Change-event re-entrancy** — handled upstream (deferred dispatch);
  our listener only bumps a counter.
- **Empty-state honesty** — a brand-new DAO shows an empty timeline; the
  explicit empty state covers it.