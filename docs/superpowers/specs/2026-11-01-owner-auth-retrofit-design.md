# Owner Authentication Retrofit — Settle & Appeal (protocol fix) — Design Spec

Date: 2026-11-01 · Status: approved in brainstorm (follow-up to slice #4c's flagged gap) ·
Builds on: `2026-11-01-targeted-verification-design.md` (the owner set exists).

## Problem

Settle and appeal authenticate the submitter by **payload claim only**:
`payload.submitter !== op.signerId → -1` is self-consistency, not ownership — any member can
forge `payload.submitter` as themselves on SOMEONE ELSE'S contribution and the handler admits it
(membership + status/step gates don't tie the claim to the contribution's true owner). Slice #4c
fixed this for the NEW `reassign_verifiers` op via the machine-recorded owner set
(`CONTRIB_NAMES.owner`); the two pre-existing handlers keep the forgeable pattern.

## Decision

**Both handlers authenticate against the owner set** — the same gate reassign uses:
`try { node.addORSet(CONTRIB_NAMES.owner(id)); } catch {}` + `!state.setContains(OWNER, op.signerId) → -1`,
placed with the other ownership gates (after the membership check, before state mutation). The
`payload.submitter !== op.signerId` self-consistency check STAYS (defense in depth, cheap).

**Legacy note (accepted):** contributions submitted BEFORE the owner set existed (pre-d890d57
op logs) carry no owner element — their settle/appeal ops will be machine-rejected AFTER this
change. Accepted deliberately: the only such data in any real DB is unhydratable stale debris
(the operator's `./data/wavedb` skips those ops at boot anyway), and fresh-DB e2e/jest flows
always ride the current submit handler, which stamps the owner unconditionally (targeted or not).

## Scope

- `shared/src/handlers.ts`: the two gates (settle + appeal) — ~8 lines.
- `server/test/targeted-verification.test.ts`: 4 contracts (settle by the TRUE owner → 0; settle
  forged by another member → -1; same pair for appeal; untouched handlers' pre-existing suites
  stay green).
- No client/store/page changes (the cosmetic layer already gates; the machine is the referee).
- Verification: full jest; main e2e + feed walk unchanged (the e2e arcs already act as the
  true submitters — they pass through the gates unbroken).