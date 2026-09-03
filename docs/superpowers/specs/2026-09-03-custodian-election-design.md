# Custodian Election Design

**Date:** 2026-09-03
**Status:** Approved

## Overview

The DAO gains a custodian role with 5 seats. Custodians control token distribution
settings and can remove members. Custodians are elected by all members through an
approval-style direct election; tied seats are resolved by a quadratic runoff. Every
user holds a full mirrored copy of the DAO state machine, synchronized through the
server; custodianship is enforced by the CRABS policy engine on every mirror.

## Election Lifecycle

New operations flow through the existing `submit_op` → broadcast path. Elections use
the 60-second default expiry like proposals.

### start_election
- Payload: `{electionId, candidates: string[]}`.
- Any member may start an election. The payload carries the current member list as
  candidates; the handler validates every candidate against the `members` set.
- Creates per-candidate vote counters, a ballot-dedup set, and an expiry register.
- Multiple elections may exist concurrently (each is self-contained).

### cast_ballot
- Payload: `{electionId, picks: string[]}` — 1 to 5 usernames.
- One ballot per voter per election (dedup set; second ballot → -1).
- Every pick must be a candidate in the election.
- Each pick increments that candidate's vote counter.

### finalize_election
- Callable only after election expiry.
- Ranks candidates by counter; unambiguous winners fill seats in vote order.
- If candidates tie at the seat cutoff, the finalize handler records the tied set and
  spawns a quadratic runoff election for those seats.
- Runoff voting reuses the quadratic model: repeated votes allowed, cumulative n^2
  cost from the voter's per-runoff token mirror (same model as quadratic proposals),
  60-second expiry.
- After runoff expiry a second finalize fills the remaining seats; if the runoff also
  ties at the cutoff, alphabetical username order is the final deadlock guard.
- Fewer than 5 candidates receiving any votes → remaining seats stay empty until the
  next election.

## Custodianship as a CRABS Attribute

- The finalize handler writes winners into a deterministic result register
  (`election:{id}:winners`, seat-ordered). Handlers cannot grant roles (CRABS
  `grantRole` lives on the Node, not in handlers).
- The server, executing `finalize_election`, reads the result and issues
  node-key-signed `grantRole(user, 'role', 'custodian')` operations, plus role
  revocation for outgoing custodians, and broadcasts those attribute operations to
  all connected browsers.
- Browsers execute the broadcast grant/revoke operations on their own mirrors, so
  every user's copy of the DAO state machine converges on the custodian set.
- Login/registration receive the current custodian list in the `attributeMachine`
  summary (extended to `role:member reputation:1 [custodian:…]`).
- Custodian-gated operations use the CRABS policy engine (`role:custodian`);
  non-custodians are rejected identically on every mirror.

## Custodian Powers (any single custodian)

### set_token_config
- Payload: `{intervalMs, rate}`. Policy: `role:custodian`.
- Writes two config registers (`config:distribution_interval`,
  `config:distribution_rate`) that `distributeTokens` reads instead of the
  compile-time `TOKEN_CONFIG` constants, falling back to `TOKEN_CONFIG` values until
  a custodian changes them.
- Applies from the next distribution tick; existing per-user `last_dist` registers
  keep the cadence monotonic.

### remove_member
- Payload: `{username}`. Policy: `role:custodian`.
- Removes the user from the `members` set, zeroes their token balance and
  `last_dist` registers.
- Server-side, out-of-band (like registration), the server revokes the CRABS user so
  their signatures stop passing.
- If the removed user held a custodian seat, role revocation frees the seat; the seat
  stays empty until the next election.

## UI

- New **Custodian election** panel: current custodians (seats 1-5), "Start election"
  button, ballot UI (checkbox list of members, max 5 picks, disabled after voting),
  live vote counts, countdown; when a runoff is active, a quadratic vote interface
  with cost display.
- Members panel gains a "custodian" badge (next to "you").
- Custodian-only controls (enabled only for seat holders): interval + rate inputs with
  "Apply", and a remove button next to each non-self member.

## Error Handling

Handlers return -1 for: expired election, second ballot, unknown or duplicate picks,
runoff over-cost, non-custodian attempting gated operations (also enforced by the
CRABS policy engine), removing a non-member.

## Testing

Unit tests (mock-state harness, same pattern as the voting tests):
- ballot dedup and 5-pick cap
- unambiguous top-5 fills seats
- tie at cutoff spawns a runoff
- runoff resolves the remaining seat
- alphabetical deadlock guard on a tied runoff
- under-filled seats stay empty
- `set_token_config` changes distribution math
- custodian policy rejects non-custodians
- `remove_member` clears membership, tokens, and seat

Smoke test: register 3-4 users, run an election, custodian changes the interval,
custodian removes a user.

## Compatibility

No changes to existing proposal or vote payloads. New operation types are additive.
Server data may be cleared at rollout since this is a demo.