# Multiple Choice Voting Design

**Date:** 2026-09-03
**Status:** Approved

## Overview

Proposals gain a creator-defined option list. Binary yes/no becomes a special case
(`options: ['Yes', 'No']`); any proposal may instead define 2–10 custom options. The
voting model (direct / quadratic) and the choice model (binary / multiple choice) are
orthogonal. One unified vote payload and one outcome rule cover every combination.

## Data Model (`shared/src/types.ts`)

```ts
export interface ProposalPayload {
  proposalId: string;
  title: string;
  description: string;
  proposalType: 'direct' | 'quadratic';
  options: string[];   // 2-10 non-empty, unique options; binary = ['Yes','No']
  expiresAt: number;   // epoch ms
}

export interface VotePayload {
  proposalId: string;
  choice: number;      // index into options (0-based)
}
```

Validation:
- create_proposal: 2-10 options, each non-empty, no duplicates.
- vote: `choice` must be an integer with `0 <= choice < optionCount`.

## State Machine (`shared/src/handlers.ts`)

### create_proposal
- Validates options, stores `options.length` in register
  `proposals:{id}:option_count`.
- Creates one ORSet + PNCounter per option: `votes:{id}:opt{i}` and
  `votes:{id}:opt{i}_count` (replacing the hardcoded yes/no sets).
- Existing registers (type, expires, executed, passed, voters one-shot set,
  quadratic mirror ORSet) are unchanged.

### vote
- Expiry check, direct dedup (one-shot voters set), and quadratic cost check are
  unchanged — all are orthogonal to which option is chosen.
- Vote key: `signerId:voteNumber` where `voteNumber` is 1 for direct and n for the
  n-th quadratic vote action.
- The vote is added to the chosen option's set and that option's counter is
  incremented.
- The dead "remove opposite vote" branch for direct votes is removed (direct dedup
  already prevents second votes).

### execute
- Reads all option counters (`opt{0}_count` .. `opt{N-1}_count`).
- Passed only if the leading option's count is a strict majority of all votes cast
  (`leaderCount > totalVotes / 2`). Ties or plurality-without-majority → fail.
- Result registers: `proposals:{id}:passed` (0/1) and new
  `proposals:{id}:winner` (winning option index, or -1 if none).
- Pre-expiry early execution kept and generalized: fires only when the leading
  option already has >= VOTE_THRESHOLD votes AND a strict majority of votes cast
  so far.
- Zero votes cast → no majority → proposal fails.

Binary equivalence: with two options, "strict majority" (`yes > (yes+no)/2`) is
mathematically identical to the previous `yes > no` rule.

## Client (`client/src/dao.ts`, `client/src/ui.ts`)

- `BrowserDao.getProposalOptionVotes(id): number[]` returns per-option tallies,
  replacing `getProposalVotes`'s `{yes, no}` shape.
- Proposal form gains an **Options** input (comma-separated; empty → binary
  Yes/No) for both proposal types.
- Proposal card renders one vote button per option; quadratic keeps its token
  info line (used / next cumulative cost / balance). Direct proposals disable
  vote buttons after the first vote, regardless of which option was chosen.

## Error Handling

Rejected operations (`-1` from handlers) for:
- expired proposal (unchanged)
- duplicate direct vote (unchanged)
- unknown option index (new)
- quadratic cost exceeded (unchanged)
- malformed proposal payload: wrong option count, empty or duplicate labels
  (rejects creation)

## Server

No new endpoints or message kinds; only handler changes flow through the
existing `submit_op` path.

## Testing (`server/test/handlers.test.ts`)

- Binary proposal still works via `options: ['Yes','No']`; majority rule
  reproduces the old `yes > no` behavior.
- Direct multiple-choice: voting an option succeeds, duplicate vote rejected.
- Quadratic multiple-choice: cumulative n² cost accrues across different options.
- Execute: winner recorded on strict majority; tie and 5/3/3 split →
  `passed=0, winner=-1`.

## Compatibility

Vote payload shape changes (`vote: 'yes'|'no'` → `choice: number`). Existing
stored data is cleared at rollout; no backward compatibility is required.