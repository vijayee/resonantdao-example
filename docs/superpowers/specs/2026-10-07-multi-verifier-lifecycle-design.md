# Multi-Verifier Lifecycle — Design (Phase 3)

Date: 2026-10-07
Status: approved design, pending implementation plan
Depends on: 2026-09-30 phase-1 + 2026-10-03 wizard + 2026-10-06 round-spine specs (all implemented)
Source of truth: https://resonantdao.com/contribution-economy/ (verified verbatim 2026-10-06)

## Purpose

Make the money path trustworthy before it carries more economics. Today one member can mint value with a colluding verifier: `verify_contribution` trusts payload-attested `dims`/`submitter`, one verification per contribution, verifiers have no track record, and rejection is unappealable. Phase 3 builds the multi-verifier lifecycle:

1. Two-verifier review for high-value dimensions using the schema engine's existing `all-parties` requirement mode.
2. Deterministic tier-0 auto-accept is NOT part of this phase (re-evaluated; see Scope) — instead: reciprocity conflict check, appeals, and verifier-accuracy tracking.
3. A verifier accuracy surface for reviewer-capture context.

## Spec sections from the source page this implements

- Tiered verification: "Software check with a random audit / two or more reviewers / appeal to the rotating panel" — phase 3 implements the *two-or-more reviewers* + appeal skeleton; random audits (Tier 1) and the rotating appeal panel (Tier 3) stay deferred.
- "Check reviewers have no stake" — implemented as the reciprocity guard (mechanical, see below) + original-verifier exclusion on appeal.
- Reviewer capture (C_18): accuracy-vs-chance tracking and rotation stay deferred; phase 3 ships the per-verifier accuracy *registers* and UI so the data exists.

## Decisions (locked 2026-10-07)

- **D8 — Schema-declared reviewer counts:** the verify step's `requirement` becomes part of the dimension schema: C_1 `{mode: 'all-parties', count: 2}` (it pays the largest bounty); C_2/C_18/default stay `{mode: 'single', count: 1}`. Chosen over value-threshold routing: deterministic, no tunable threshold, wizard progress displays for free, doesn't game via partial-match splitting.
- **D9 — Majority semantics for count 2:** any rejection terminates the lifecycle immediately (existing strict rule); acceptance requires ALL required verifiers to pass. With count 2: both-pass or dead.
- **D10 — Reciprocity guard:** a member cannot verify a contribution whose submitter was the most recent submitter they *verified themselves* (collusion loop breaker). Stored in a `last_verified:{user}` register, updated on every completed verification.
- **D11 — Appeals:** the submitter of a rejected contribution may appeal once: status 3 (appealed), lifecycle rewound to the verify step, original verdict-setter barred from re-verifying. No chained appeals in phase 3. **Execution amendment (2026-10-07):** the appeal also resets the verify step's completion counter (decrementPNCounter to 0) — rewinding only the step pointer would leave the pre-appeal rejection occupying a quorum slot of the all-parties requirement; the reset makes the appealed re-review require the full fresh quorum (the old verifiers are already reciprocity-barred).
- **D12 — Verifier accuracy (read-only):** `check:{user}:total` and `check:{user}:upheld` registers; upheld increments when a contribution that user verified ends accepted at settle. Capture detection (accuracy-vs-chance, rotation) stays deferred.
- **D13 — Voting untouched:** the parked RCT-as-vote-token question stays open (documented in the phase-2 spec); nothing in this design reads or writes vote-balance registers.

## Data model (new CRABS holdings)

| Holding | Key | Written by |
| --- | --- | --- |
| Reciprocity guard | ORSet `recip:{submitter}` — elements = verifiers who have verified this submitter (tags = contributionId-unique) | verify handler |
| Appeal flag | register `contrib:{id}:appealed` (0/1) | appeal handler |
| Verifier accuracy | registers `check:{user}:total`, `check:{user}:upheld` | verify (total) / settle (upheld) |

**Reciprocity guard (handler-enforced):** before agreeing to verify a submitter, the verify handler checks `!setContains(recip:{submitter}, op.signerId)` — a member A may verify B only if B has never verified A (conservative, monotone version of "no stake": mutual-verification pairs are permanently barred; relaxation to a recency window is deferred with the capture-rotation work). On each verification the handler adds the actor to `recip:{submitter}`. Deterministic: membership tests and adds derive from payload bytes only.

**Original-verifier exclusion (client-enforced, documented limitation):** registers are numeric and handlers cannot enumerate ORSet elements, so "the original verifier may not re-verify after an appeal" cannot be expressed handler-side. The client (BrowserDao tracks `verifiedBy` per contribution entry) refuses to offer/submit a verify op from the original verifier on an appealed contribution; the handler-side exclusion is deferred until CRABS exposes set enumeration or string registers. Pinned by a UI test. The state machine stays honest rather than faking an exclusion it cannot express.

## Handler changes (shared/src/handlers.ts)

- **Schemas** (`shared/src/contribution.ts`): C_1's verify step `requirement: {mode: 'all-parties', count: 2}`; single-verify dims unchanged. `SCHEMA_VERSION` bumps to 'v2'? Schema content changed — bump to 'v2' with the mapping constant updated ('v1'/'v2' ↔ 1/2) so old contributions (v1, submitted under 3-step schemas) still hydrate read-only-compatible — NO: schemaVersion gates wizardModel read-only. Old contributions with schemaVersion v1 must still render; resolution: `wizardModel` treats ONLY unknown versions (not in CALIBRATION_VERSIONS-style registry) as read-only; 'v1' facts use the schema AT RECORD VERSION: keep a LEGACY_SCHEMA map (v1 → the 3-step/2-step single-verify schemas) alongside v2's two-verifier C_1. WizardModel gains `schemaForRecord(schemaVersion, dims)` — shared function resolving legacy v1 vs v2. Handlers: a v1 contribution continues verifying under v1 rules (one verifier); v2 contributions require C_1 two-verify. Clean.
- **verify_contribution**: all-parties enforcement — per-actor one-completion check (element tag = the actor's existing per-check record already tags `verify:{actor}`; a second verify by the same actor hits tag-duplicate dedupe, but that's a silent drop → make it a REJECT: handler validates via... cannot read elements! **Payload-attested count instead:** the op must be *submitted by a distinct actor than existing verify records*; handler cannot check → client enforces + handler pins what it CAN: rejects self-verification (existing) and relies on the mirror UI; document). Reciprocity check: `setContains(RECIP_NAMES.byUser(submitter), op.signerId)` → -1; on pass completion: `setAdd(recip set, op.signerId, contributionId-tag)`. Verifier `check:{actor}:total` increment on every completed check. Status: with count 2, a reject terminates (existing path); acceptance completes the lifecycle only when ALL count-2 checks have passed in the same direction — the existing `isFinal` logic covers it (each bump advances; final requirement completes acceptance).
- **appeal_verdict** (new op, role:member per member policy): payload `{submitter, reason}` on a contribution whose status === 2; requires the appealed register 0; sets appealed=1, status=3? — status registers are numeric: 3 = appealed; the verify step's status gate accepts 0 OR 3; explanation record `{stepId:'appeal', reason, at}` tagged `appeal:{signer}`. Verify rejection after appeal re-terminates (status 2); acceptance after appeal completes normally (status 1 via existing rules).
- **settle_contribution**: on completion, increments `check:{v}:upheld` for each verifier of record — unreadable client-side? mirror-held; payload-attested again: settle payload gains `verifiers: string[]` (client-known) validated as members; each verifier's `upheld` register incremented (declare-first).
- **wizard.ts**: status 3 renders like 0-current (verify step current, progress visible) + an "appealed" pill; roles gating unchanged.

## UI

- Contribution cards: verify button hidden for `entry.verifiedBy` holders on appealed cards (client-enforced exclusion; commented); "(1/2)" progress appears on C_1 contributions; accuracy ratio `upheld/total` shown on verify prompts; rejected cards show the appeal button (submitter only, once).
- The verify modal gains a warning line when the payload-attestation caveat applies (always) — kept minimal: a static helper text.

## Error handling

- Reciprocity violation → -1 (op rejected, logged+skipped on replay per PoC convention).
- Appeal on accepted/pending/unknown → -1; second appeal → -1.
- All-parties with a repeated SAME actor: cannot be detected handler-side; the client refuses to offer it (UI test pins it) and cross-verifier payloads make the math self-consistent (bump still increments but final acceptance math is deterministic from payloads — a same-actor double-verify yields both bumps; the guard is the status-finalization, so no double submitter pay; the duplicate verifier's per-check credit WOULD double-pay — flagged limitation, pinned in a test explaining it).
- Wrong-step appeals/verifies → existing position checks.

## Testing

- Unit: reciprocity set behavior, appeal state transitions (2 → 3 → 1/2), all-parties progress via counter bumps, majority-terminate rule, accuracy increments, schemaForRecord legacy resolution.
- Mock handler tests: two-verifier C_1 flow (both passes → accepted; one reject → dead), appeal flow end-to-end, reciprocity rejection, double-appeal rejection.
- Real wasm: v2 two-verifier lifecycle + appeal + reciprocity through DaoNode; legacy v1 contribution still verifies single.
- Hydration: reciprocity/accuracy registers survive replay.
- UI manual + e2e extension (two-page flow: two verifiers, appeal path, accuracy badge).

## Scope / deferred

- Tier 1 random audits + rotating appeal panel (Tier 3): deferred (deterministic pseudo-random sampling design still to be discussed).
- Accuracy-vs-chance detection + reviewer rotation: registers now, logic later.
- Reciprocity relaxation (window-based vs permanent), chained appeals, harm adjustments (option B), retrieval economy (option C), RCT-vote-token question: all parked with their docs.

## PoC limitations carried/extended

- All-verifier identity/dims remain payload-attested (unchanged class of limitation, now more places) — every replica recomputes identically from the same bytes; capture-hardening registers make abuse *visible*, and phase 3 adds no cryptographic attestation. Reviewer capture remains THE deferred security work.