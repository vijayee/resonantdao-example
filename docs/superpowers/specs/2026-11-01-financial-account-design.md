# Financial Account Page (Slice #5) — Design Spec

Date: 2026-11-01 · Status: approved in brainstorm · Builds on: #4b/#4c wizard substrate; the
read-only layering rule (protocol in the machine, cosmetic elsewhere).

## Problem

`/account` is a placeholder. The machine already carries the financial truth — `$RES` balance
register (moves ONLY through verified work: bounties/credits at settlement, per-check credits,
vote spends), `RCT` per-member aggregated round weight, 22 per-dimension tallies, and the feed
mirror's financial rows. The page renders that truth read-only.

## Decisions

1. **READ-ONLY accounting — no protocol changes.** No transfers op this slice (flagged as the
   natural next protocol slice if wanted).
2. **Ledger = EARNED-money line items only.** Vote spends stay OUT — consistent with D2 (the
   feed's vote-privacy decision) and needing no new data. The balance register already reflects
   spends; the ledger is the income story: settled bounties/credits (harm-scaled), verification
   check credits, harm receipts.
3. **Tallies render nonzero-first**; unset/zero dimensions collapse behind a muted one-liner.

## Architecture

### Ledger projection (`client/src/wizard/ledger.ts`, TDD — the
`lifecycle.ts` precedent: client-side pure module, jest-covered from server/test; the input is a
MINIMAL STRUCTURAL type (contributionId/dims/harm), not the dao entry — no client-type imports
in shared, no mirror coupling)

```ts
export interface LedgerLine {
  at: number;
  label: string;         // '+12 bounty — "built a bridge" (C_1)' style
  amount?: number;       // signed; ABSENT when the data degrades (cap, unknown harm rule)
  sign: '+' | '−' | '?';
}

export function ledgerLines(
  feedEvents: FeedEvent[],
  contributions: LedgerContribution[],   // structural: {contributionId, dims, harm?}
  viewer: string,
): LedgerLine[];
```

Pure over the feed mirror (client/src/stores/dao feedEvents accessor already carries
type/actor/targetId/at for contribution ops). Cases:

- **Settlement payouts** (`contribution_settled` rows): the SUBMITTER's income = the
  contribution's dims' base payment (`paymentFor`) scaled by `harmFactorFor(entry.harm)` — the
  SHARED functions (single-source: handlers, receipts, ledger all read the same math). Amount
  present; label names the contribution summary + its dimension class. The line renders when
  the settle row's `actor === viewer` (post-retrofit the settle signer IS the machine-recorded
  owner); other members' settlements are never your income (the earned-only rule).
- **Verification credits** (`contribution_verified` rows w/ `actor === viewer`): +2 $RES
  (`RES_CONFIG.verificationCheckCredit`); label names the checked contribution + who submitted.
- **Harm receipts**: part of the settle line (the scaled amount + the harm annotation in the
  label) — no separate line.
- **Degrade gracefully**: rows whose amount math lacks its inputs (e.g. harm unknown because the
  mirror entry aged out) render with `amount: undefined, sign: '?'` — honest, not invented.
  Documented reporting choices (review of 2026-11-01): the ledger is also bounded by the FEED's
  own 200-event cap (older earned lines simply vanish — a recent story, not a full statement);
  and the settle line's clock reads the SETTLE event's time while the machine credits the
  submitter at the FINAL VERIFY — the line appears when settled, the balance moves earlier
  (accepted-but-unsettled work shows balance without a line). A future re-key onto the
  final-verify event would align them; pinned as a decision, not a defect.
- Zero-amount consequential events (proposal/election/reassign lifecycle rows) never render.

### Page (`client/src/components/account/AccountPage.vue`)

- Balance panel: `$RES` + `RCT` chips (via the existing `getResBalance`/`getRctBalance`
  accessors; header's token-balance pattern), each with a plain-language hint line.
- Dimension tallies panel: chips from `getDimensionBalance` (0..21), nonzero sorted first;
  zero/unset collapsed as `"<n> dimensions untouched"`.
- Ledger panel: `ledgerLines(ds.feedEvents(), ds.username)` — a line-item list (time, label,
  signed amount); empty → the honest quiet line ("nothing earned yet — settled work and
  verification checks appear here").
- The placeholder is DELETED; route points at `AccountPage.vue`.

### Survivors (untouched)

Everything else: no route/shell/store-op/machine changes; the feed page untouched; the round
wizard untouched. Header's inline token balance stays (it's the glanceable copy).

### Testing

- TDD: `server/test/ledger.test.ts` — the projection cases: settle income for the submitter
  (harm-scaled math vs the fixture's known payments), verification credit for the verifier,
  other-member rows excluded, degrade-to-'?' when the mirror lacks the entry, zero-amount
  events filtered, empty history.
- e2e: after the targeted cycle, the account page asserts the balances + at least the bounty
  ledger line (the fixtures' known amounts); gates as usual (jest/typecheck/build/devtools/
  main e2e/feed walk).