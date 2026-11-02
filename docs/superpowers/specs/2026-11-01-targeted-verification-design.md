# Targeted Verification (Slice #4c) — Design Spec

Date: 2026-11-01 · Status: approved in brainstorm · Builds on: #4b lifecycle wizards; amends the
domain model of `2026-10-03-contribution-wizard-data-design.md`; protocol per the state-machine/
cosmetic divide (2026-11-01 #4b spec).

## Problem

Verification is currently open to an anonymous class: any member could verify a contribution
(the verify handler admits any non-submitter). The design intent: **the submitter selects the
verifier(s) from the DAO's member list at submission time; the selection is protocol state**
(who may change the state), and **named verifiers see the contribution in their feed and
continue the wizard** from there.

## Decisions

1. **Submitter names verifiers upfront** — at submit time, in the wizard, count = exactly the
   schema's verify requirement (C_2 → 1, C_1 v2 → 2).
2. **Screening at pick time** — the pick step offers only reciprocity-clear, non-self members;
   ineligible members show greyed with their bar named. If NO member is eligible, the step
   renders the visible dead-end ("no eligible verifiers right now") rather than inventing an
   override.
3. **Escape valve now**: a new `reassign_verifiers` op (submitter-only, while verification is
   incomplete) names ADDITIONAL verifiers (count = remaining slots; already-completed checks
   stand; the named set grows — never shrinks). Feed row included (consequential op).
4. **Legacy compatibility**: a submitted payload WITHOUT the verifiers field keeps today's
   exactly-open behavior (class rule) — old contributions, old jest suites, and any client that
   predates targeting verify/are-verified under v-era rules.

## Architecture

### State machine (shared/src — the protocol representation)

- `VerifyContributionPayload`-style addition to submit: `verifiers?: string[]` on the submit
  payload, validated when present: members (setContains, STATE_NAMES.members), pairwise
  distinct, none equal to the submitter, length === the wired schema's verify step
  requirement.count. Violations → reject (-1). Absent → untargeted.
- **`CONTRIB_NAMES.verifiers(contributionId)`** — new OR-set register (policies.ts) holding the
  named verifiers: submit writes the initial names; reassign adds. Reads (client + handlers) go
  through setContains, iterating the known member list (the established read pattern, as
  elections' candidate read does).
- **`reassign_verifiers` op** (new CONSEQUENTIAL_OPS member + handler): payload
  `{ contributionId, verifiers: string[] }`; gates: submitter-only op signer, membership set
  exists, status pending/appealed, the verify step exists and is incomplete
  (stepDone < requirement.count), each new name member/distinct/≠submitter, **length exactly
  equal to the remaining slots** (requirement.count − stepDone). Handler adds the names to the
  OR-set. Server-side handlers + client handlers identical (shared module).
- **Verify handler gains the targeted gate**: when the named set is NON-EMPTY, the signer must
  belong to it (in addition to all existing gates: no-self, reciprocity, distinct-actor,
  status/step). Empty set (untargeted legacy) → today's rule verbatim. The appeal arc leaves the
  set untouched — a rewound contribution re-verifies under the SAME named verifiers (reassign
  remains available if they've lapsed).

### Projection (shared/src/wizard.ts — read-only re-derivation)

- `ContributionFacts` gains `verifiers?: string[]` (the named set, assembled by the client's
  `contributionFacts` from the dao accessor).
- Verify-step `mayAct`: targeted (set non-empty) → `viewer ∈ facts.verifiers` AND the standard
  bars (no-self is implied — the submitter can't name themself; reciprocity stays); untargeted →
  today's class rule.
- **Waiting text flips to determinate**: targeted verify phase → `'awaiting <remaining names
  joined>'` — WHO acts next is now recorded state; the never-a-member-name rule stands ONLY for
  untargeted contributions ('awaiting a verifier'). The #4b spec's rule + lifecycle tests are
  AMENDED accordingly (the rule was correct for an indeterminate domain; targeting makes the
  actor determinate).
- The feed's `contribution_verified` rows and the attention band are unchanged mechanically —
  they already gate by mayAct, so targeted verifiers' band items light automatically, including
  for newly-named ones (reassign → push-bump → band refreshes). Submit/reassign feed rows:
  reassign gains a consequential-op row (builder case: 'X named Y… as verifier(s)').

### Wizard UX (client)

- New shell step kind **`'members'`**: `{ kind: 'members'; id; title; count: number }` —
  checkbox list (one per offered member), validation: exactly `count` selected; the answer
  serializes as a comma-joined name string (draft rules unchanged). The factory computes the
  OFFERED list at flow build: ds.members minus self, filtered by the reciprocity/eligibility
  read, eligible first; ineligible rendered disabled with the bar named.
- Submit wizard inserts the pick step after the type choice; `contributeNewFlow`'s factories
  take the count from the chosen dim's schema and the op payload carries `verifiers`.
- The **reassign affordance** on the contribution page (like appeal's section): visible for the
  submitter while the verify phase is current with slots remaining; opens the reassignFlow
  (members step, count = remaining) → reassign op → the page re-projects (push-bump).

### Store / mirror (client)

- `submitContribution` gains the verifiers payload param (the wizard supplies it);
  `reassignVerifiers` store op (boolean contract); a dao accessor
  `getDefinedVerifiers(contributionId): string[]` — member-list scan against the OR-set. NO new
  mirror field: the register IS the assignment state; projection/feeds read it directly.

### e2e / jest fallout

- Jest: submit handler tests (validation incl. count/wrong-member/self/duplicate/absent-legacy),
  verify handler's targeted gate (named verifier accepted; unnamed member REJECTED — a protocol
  assertion), reassign handler (gates + growth + remaining-count rule), wizardModel targeting +
  waitingText flip + legacy fallback; the #4b lifecycle suite's waiting-text tests amended.
- Main e2e: submit helper picks verifiers via the members step (screened list assertions: the
  submitter absent, barred greyed); verify drivers act as the NAMED users; NEW protocol assert:
  a fourth user (not named) attempting verify is REJECTED (op_rejected surfaces; tallies change
  not). Feed walk untouched.

## Testing

- TDD at every pure seam (handler suites, wizardModel targeting tests, shell 'members' kind
  validation); the main e2e remains the protocol gate; gates unchanged (jest, typecheck, build,
  devtools-leak, main e2e, feed walk, dialog grep).