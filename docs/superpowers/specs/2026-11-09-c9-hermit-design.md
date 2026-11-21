# C_9 Hermit — Discovery Claim (Slice #6h) — Design Spec

Date: 2026-11-09 · Status: ruled in the campaign directive · The milestone shape reused; the
new piece is the ADOPTION TIE — the finding linked to a proposal the machine says was EXECUTED.

## Design (spec)

- **C_9 is a submittable claim** — schema `[submit → verify (the finding) → verify-2 (the
  steering validation) → settle]` — the C_7 milestone machinery VERBATIM (data-only entry; the
  named verifier checks both gates).
- **The ADOPTION TIE (optional payload field `proposalId?`)** — the decision the finding steered.
  The gate: when present, the proposal must be a REAL one AND already EXECUTED
  (members set + the executed register) — an unexecuted/missing tie → -1. The tie validates at
  SUBMIT (stamps `CONTRIB_NAMES.proposalTie?/adopted` — the register pattern; re-carried + pinned
  at verify per the C_19 pattern: `PROPOSAL_TIE(id)` … the register names:
  `CONTRIB_NAMES.adoptedTie(id)` OR-set).
- **Payments**: the standard claim tally (the filer's C_9 tally, match × alphaFor(9) × harm at
  final verify) + the **ADOPTION BONUS**: `RES_CONFIG.adoptionBonus = 5 $RES` to the filer WHEN
  the tie is present AND executed (paid at final verify — the $RES idiom). No tie → the deep-work
  path only.
- **Picker**: C_9's selling line; pickable; the claim flow's OPTIONAL proposal-tie pick: an
  evidence-like step offering the viewer's EXECUTED proposals (their ids, labeled by title)?
  Executed proposals may be NONE — the step is OPTIONAL (skip-able), riding the evidence kind's
  optionality... a members-kind with count 0-or-1? The members kind validates exact-count. NEW
  resolution: the tie pick rides the EXISTING members kind with `count: 0` when the viewer has no
  executed proposals (validate exactly 0 → pass) — dynamic count 0|1. Review shows the tie.
- **Feed/lifecycle**: the claim rows cover it; the WAITING_TEXT rides 'verify-2'.

## Plan (tasks)

**Task 1 — protocol (TDD)**: flags + the SCHEMAS 9 entry (the C_7 shape) + `RES_CONFIG.adoptionBonus`
+ `CONTRIB_NAMES.adoptedTie` + the CLAIM_RULES-9 branch (the tie validation at submit; the pin +
bonus at final verify). Contracts: D-A no-tie arc (the two milestones + the tally, NO bonus);
D-B executed-tie arc (the tally + the +5 $RES bonus); D-C an UNEXECUTED-tie submit → -1;
D-D a forged re-carry pin; D-E $RES invariant (the bonus is the only money; the checks pay +2).
Commit: `feat(state): C_9 Hermit — discovery milestones with the adoption tie (TDD)`.

**Task 2 — client/flow**: the claim derivation (9 → the optional adopted-tie pick: members kind
with the viewer's EXECUTED-proposal options and count (executedList.length ? 1 : 0)); DIM_DESCS
9; the lifecycle rendering rides. Gates. Commit:
`feat(contribute): the discovery claim — milestones plus the adopted-decision tie`.

**Task 3 — e2e**: the arc (alice files C_9 after a proposal executed in the run; ties it;
reviewer pair checks both milestones → alice's C_9 chip exact + the +5 bonus line on her
balance delta). Commit: `test(e2e): the discovery arc — milestones plus the adopted-decision bonus`.

**Task 4 — verification + the de-wonk close** (the standing recipe; the audit LAST).

## Open calls (auto-resolved, veto in review)

- The adoption bonus = 5 $RES (modest vs the 12 building bounty; a finding is directional).
- One named verifier across both milestone gates (the standing C_7 pattern).
- The tie target = EXECUTED proposals only (the machine's adoption truth).
