# Round Spine, $RCT Aggregation & Salient Voting Balance — Design (Phase 2)

Date: 2026-10-06
Status: approved design, pending implementation plan
Depends on: 2026-09-30-replace-timed-allocation-contribution-workflow.md + 2026-10-03-contribution-wizard-data-model.md (both implemented, 2026-10-04)
Source of truth: https://resonantdao.com/contribution-economy/ (verified verbatim 2026-10-06); prior model docs: docs/contribution-economy/README.md

## Purpose

Phase 2 of the contribution economy binds the round machinery to the running app:

1. The **round spine** — C_10 fair round close (audited), C_20 reckoning, C_21 completion — as human-driven sequential ops, `role:member`, during the human-only bootstrap the source page assumes.
2. **$RCT aggregation + publication** at round complete: the derived summary per member, published to registers with explanation records; the 22-vector remains the source record.
3. **Salient-dimension voting balance**: quadratic votes derive their spend balance at vote time from the question's declared salient dimensions × the voter's verified dimension tallies — the page's voting clause — replacing the token-balance gate.

## Decisions (locked 2026-10-04 → 2026-10-06)

- **D3 — Round scope:** phase 2 = round spine + aggregation + salient voting balance.
- **D4 — Voting mechanics unchanged; balance source replaced.** Quadratic cost (cumulative n²), mirror-set bookkeeping, expiry gating, elections: all as implemented. Only the balance that gates the cost changes: from `res:{user}` to the salient-derived value computed in-handler at vote time.
- **D5 — $RCT publish-only.** RCT is computed and published at round complete but wired to nothing in this phase. The RCT-as-vote-token question (and the page's "`$RCT` … never scales a vote" clause) remains **open for discussion**; documented in both directions in this doc.
- **D6 — Round spine actors:** any member drives all three spine ops in sequence (matches "human-only bootstrap"; avoids the browser wrapper's missing schedule API entirely).
- **D7 — Aggregation is payload-driven:** consistent with the established PoC trust model (payload-attested verify inputs), the client collects the round's settled-accepted contributions into the `complete_round` payload; the handler validates entry shapes/existence and recomputes deterministically from the same bytes on every replica.

## Source-page conformity

- Formula shape: `$RCT = aggregate(alpha_i × N_i(C_i))` — pilot stand-in is the linear sum with default weights, documented as pending calibration (page defers the final formula post-pilot; "must stay explainable and reproducible" — satisfied: pure register math + explanation records).
- **Null-preserving normalization** (`N_i` treats null as unscored, not zero; "null never decays into zero"): achieved structurally — a member with no settled contribution in dimension i has no tally register and contributes `alpha_i × 0` only via *scored dims*; unscored dims are absent from the aggregation input entirely (no tally → no entry). Aggregation runs from settled-contribution dims, never from undeclared reads.
- **Justice gate**: "*Judgement cannot finalize a cycle without a current Justice calibration and a readable audit record*" → `reckon_round` (C_20) requires both a stage-1 audit AND a current calibration version register.
- Voting: "base membership plus a bounded multiplier drawn from the voter's verified balances in exactly the salient dimensions", hard caps, capital-derived portions excluded. Modeled as: `baseWeight + Σ alpha_i × tally_i`, capped; salience declared per question. **Deviation (documented):** the page derives vote *weight*; the pilot derives a *spending budget* run through the pre-existing quadratic cost machinery. Same salience logic, different curve semantics — recorded here deliberately for demo continuity.
- Unresolved items roll: "a disputed action can remain pending into the next cycle without creating an automatic negative balance" — pending contributions at round close are excluded from aggregation and belong to the round stamped at their submit; nothing blocks the next round.

## What lives where

### New CRABS holdings (all registers/ORSets follow existing patterns)

| Holding | Key | Notes |
| --- | --- | --- |
| Current round | register `round:current` | starts 1; incremented at completion |
| Round stage | register `round:{n}:stage` | 0 open, 1 audited, 2 reckoned, 3 complete+published |
| Round explanation records | ORSet `round:{n}:e` | one JSON record per spine op (deterministic unique tag `{stepId}:{signer}`) |
| Round debt (unfair closes) | element in `round:{n}:e` | the audit record itself is the debt record; no aggregation on unfair close |
| Contribution's round | register `contrib:{id}:round` | stamped at submit (submit handler gains this write) |
| Alpha weights | 22 registers `config:alpha:{i}` + register `config:alpha_ver` | unset (0) → pilot default 1.0 |
| Salience mask per proposal | register `proposals:{id}:salient` | 22-bit mask, from payload `salientDims` |
| Vote base + cap | registers `config:vote_base`, `config:weight_cap` | pilot defaults (base 3, cap 50) |
| Published RCT | register `rct:{user}` | written only at complete_round; absence = unscored member |

### New op types

- `audit_round` (role:member): payload `{fair: boolean, note: string, calibrationVersion: string}`. Validations: note non-empty; stage 0; calibrationVersion matches `config:calibration_version` (new register; when 0/unset → 'v1'). Fair → stage 1. Unfair → debt audit record appended, stage jumps to 3 *without aggregation*, round advances (page: "the system records the debt and retries next round").
- `reckon_round` (role:member): payload `{note: string}`. Requires stage 1 AND calibration-version register non-zero-or-fallback present (Justice gate). → stage 2. PoC simplification: reckoning is a human attestation; per-record reconciliation is deferred with C_11/C_20's real logic to later phases.
- `complete_round` (role:member): payload `{entries: [{contributionId, submitter, dims}]}`. Requires stage 2. Handler: validates every entry (shape, isValidDims, contributionId exists in CRABS — *and is stamped with this round via `contrib:{id}:round`* — no duplicate ids), computes per-submitter `rct:{submitter} += Σ_{dims} alpha_i × match` (alpha from registers, default 1.0 when unset), writes/accumulates `rct:{user}` registers, appends the aggregate explanation record (round, entry count, round's totals, calibrationVersion, alpha version), sets stage 3, increments `round:current`. Entries referencing pending/rejected/unknown/other-round contributions → reject (fail-closed). Published `rct:{user}` is therefore the **cumulative** summary through the current round (the tallies it aggregates are cumulative too); an alpha change is **forward-looking** in the pilot — it weights new contributions, not history. The page's time-indexed `RCT(u,t)` is served by the per-round explanation records, which preserve each round's totals and the alpha version used.
- `set_rct_alpha` (role:custodian): payload `{weights: Record<index, number>, version: string}`. Validates subset of 0–21, weights finite in (0, 10]; writes the alpha registers + version; appends an explanation record.
- `set_calibration_version` (role:custodian): payload `{version: string}` — validated against the known calibration versions ('v1' only in phase 2) and stored numerically (`'v1'` ↔ 1) in `config:calibration_version`; the readable string lives in the op's explanation record. The Justice gate compares the stage-1 audit's recorded calibrationVersion to this register (with unset/0 → 'v1').

### Voting changes (only files: shared/src/handlers.ts vote paths + create_proposal + UI gating display)

- `create_proposal` payload gains optional `salientDims: number[]` (0–21, unique, ≤22 entries); handler writes `proposals:{id}:salient` bitmask (0 when absent).
- Quadratic vote handlers compute at vote time:

```typescript
const salientMask = state.getRegister(<proposals:{id}:salient>) || 0;
const base = state.getRegister('config:vote_base') || 3;
const cap = state.getRegister('config:weight_cap') || 50;
let balance = base;
for (let i = 0; i < 22; i++) {
  if (!(salientMask & (1 << i))) continue;
  const alpha = state.getRegister(`config:alpha:${i}`) || 1;
  const tally = state.getRegister(`dim:{user}:c${i}`) || 0;  // unscored → still 0, but excluded by mask semantics
  balance += alpha * tally;
}
if (balance > cap) balance = cap;
```

(Note: with a mask, *absence* of a salient dim is structurally unscored — the mask itself is the null-preservation mechanism for voting.)
- Runoff/custodian-election votes: no salient declaration exists for elections → base-quadratic only (documented).
- Direct votes unchanged.
- $RES: keeps its earned/transferable role and payment rules; its gate-the-votes role is retired (voting no longer reads `res:`). Flagged in docs.

## RCT-as-vote-token — the open question (documented, per user 2026-10-06)

The pilot author originally considered making $RCT the voting token (votes spend the published summary). The source page states: "`$RCT` sets thresholds, never weights. It may gate eligibility, quorum, or standing. It never scales a vote." Voting-token semantics (spending RCT) would make vote power *derive from* RCT — a deviation from the page's core use-gate; the pilot's salient-balance model (D4/D7) instead implements the page's voting clause directly (balances in salient dims + base + caps). The question of what the source page "really meant" — whether RCT could ever be a spendable vote currency — stays open for future discussion; this design neither implements RCT-as-vote-token nor forecloses it, and $RCT is publish-only meanwhile. A future implementer should find this paragraph and the decision history on GitHub before changing either.

## UI

- Round panel: current round number, spine stepper (Open → Audited → Reckoned → Published; debt note shown on unfair closes), audit/reckon/complete buttons offered per stage (any member), custodian alpha/calibration forms.
- RCT badge per member in the members list (hidden/— for unscored members).
- Proposal creation gains the salient-dimension picker (multi-select of the 22, default: none = base-only); proposal cards show per-voter derived balance in context: "salient dims: C_1; base 3 + weights → your balance N".
- Vote gating displays mirror the handler's derived-balance math client-side (BrowserDao helper) so UI and state machine agree.

## Error handling

- Wrong-stage spine ops → rejected (`-1`), same as existing handler rejections.
- complete_round entries: unknown contribution, duplicate id, invalid dims, or payload claiming a contribution that is pending/rejected → rejected (fail-closed; the closer retries with a corrected payload).
- Salient validation errors at create_proposal → rejected.
- set_rct_alpha: invalid subset/weights → rejected.
- Rejected ops persist-and-skip on replay (pre-existing PoC behavior, unchanged).
- Vote-time derived balance: always ≥ base (never negative tallies — verify handler writes only positive deltas; phase-1 harm reduction is NOT in phase 2).

## Testing

- Pure unit tests: aggregation math (multi-member, multi-dim, alpha defaults, null-preserving via absent dims), salient-mask encode/decode, derived-balance math with base/cap.
- Handler tests (mock state, existing pattern): spine stage progression (audit fair/unfair-debt path, reckon Justice-gate rejections, complete publishes + advances round), aggregation entry validation, set_rct_alpha validation.
- Real-wasm tests: full spine lifecycle through DaoNode incl. balances; votes against salient-derived balance (fund via verified contribution, declare salient dim, quadratic cost check).
- Hydration replay: round registers, published RCT survive restart.
- UI manual two-browser flow; e2e script extension (propose with salience → verify → settle → audit/reckon/complete → vote on next round).

## Phase boundaries

- Phase 2 (this design): round spine, payload-driven aggregation + publication, salient-derived quadratic voting balance, calibration/alpha custodian ops.
- Later phases: C_11 real fairness-audit logic (weight distortion, systematic under-measurement back-pay path), C_20 per-record reconciliation, tiered verification (Tier 1/3), harm checks (which would subtract tallies pre-aggregation), C_2 retrieval bonuses, multi-party schemas (C_8), null-vs-verified-zero representation in the 22-vector source record, reviewer-capture hardening, $RCT gating wiring (the page's thresholds clause).