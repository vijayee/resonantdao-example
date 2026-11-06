# C_20/C_21 Spine Credits (Slice #6c) — Design Spec

Date: 2026-11-02 · Status: approved (the #6 taxonomy's spine-embedded shape; "do it" 2026-11-02).

## Problem

C_20 (Judgement) and C_21 (World) are spine-embedded: their ops — `reckon_round` and
`complete_round` — are LIVE in the settlement wizard. What's missing is the designed credit
(the BPMNs' "credit the settling" / "credit the completion"): the driving member's dimension
tally.

## Decisions

1. **The driving member earns the dimension tally** — the signer of `reckon_round` gains the
   C_20 tally; the signer of `complete_round` gains the C_21 tally.
2. **The credit is weight-scaled, per the general calibration rule**: delta =
   `dimensionDeltaFor(dim, 1) × alphaFor(dim)` (match = 1; spine ops carry no harm — no
   harmFactor term), written in per-mille units, idiom-identical to the verify tally credit.
3. **NO $RES movement** (contribution-token credits only; the ledger stays an earned-money
   story). Feed rows already exist for both ops (the consequential set carries them) — no feed
   change.
4. **Idempotence/coexistence**: the ops are per-round; a re-driven round (appeal-rewound arcs)
   re-credits on each legal op — the tally accumulates as the machine's registers do (matches
   every other tally's behavior; no special guard).

## Architecture

- `shared/src/handlers.ts` (`makeReckonRoundHandler` / `makeCompleteRoundHandler`): the credit
  block after the op's existing writes — declare-first the members' tally register
  (`addRegister` idiom), read prev RAW, write `prev + toRegisterUnits(delta)` exactly like the
  verify credit (:308's neighborhood). Both handlers' node params likely need `addPNCounter`? NO —
  tally registers are plain registers (`dimensionBalance`) — `addRegister` only.
- `shared/src/contribution.ts`: DIMENSIONS flags — C_10/C_20/C_21 are spine-embedded: NOT
  pickable; nothing new (the pickable flags already rule them out of the picker).

## Testing

- TDD: the reckon credit (tally = match × alpha(20), with an unset-alpha default arc AND a
  seeded-alpha scaled arc); the complete credit (C_21, same pair); the no-$RES invariant
  (balances unchanged); the re-drive accumulation on an appeal-rewound replay.
- e2e: after the standing spine arc's reckoned + published asserts, pin the driver's C_20/C_21
  chips (exact numbers, element-scoped — the pinned-assert standard).
