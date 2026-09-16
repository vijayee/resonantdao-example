# Contribution Economy Workflow/BPM Diagrams — Design

Date: 2026-09-16
Status: approved design, pending implementation plan

## Purpose

Model the ResonantDAO contribution economy (v2 spec, https://resonantdao.com/contribution-economy/) as BPMN 2.0 workflows:

1. How each of the 22 contribution dimensions operates as a workflow, including required human interactions.
2. How the 22 dimensions interact with each other (cross-dimension dependencies).
3. How contribution value (`$RCT`) is aggregated from the 22 dimension balances.

This is a **standalone system-design artifact** — conceptual swimlanes and roles, not bound to this repo's current election/voting implementation.

## Source of truth

The contribution-economy spec page. Key invariants to preserve in every diagram:

- Pay on outcome, never on activity (submission, attendance, lecture length, pause duration earn nothing).
- Every action is multi-classified into a sparse weighted vector `P(a) = [p_0 … p_21]`.
- Delta formula: `Delta C_i(a) = Match_i × Outcome × Verification × Calibration_i`; verified harm reduces/voids the outcome beforehand.
- 22 non-transferable balances; `null` (no evidence) never becomes `0` (verified zero); null never decays into zero.
- `$RCT = aggregate(alpha_i × N_i(C_i))` is a derived summary; the 22-vector remains the source record. `$RCT` may gate eligibility/quorum but never scales votes.
- `$RES` is a separate transferable token paid only when a class-specific outcome rule fires.
- Voting weight draws only from human-attributed portions of balances in question-declared salient dimensions, with hard caps; capital-derived contribution never becomes voting power.
- Every decision emits an explanation record (action ID, evidence, dimensions, intensities, calibration version, review decisions, appeal route).
- Measurement failure is the system's debt, never the contributor's — chronic under-measurement triggers back-pay, calibration, or rule retirement.

## The 22 dimensions (Tarot numbering, C_0–C_21)

### Fully specified in source (12)

| Dim | Name | Trigger | Payment logic | Required human interactions |
|---|---|---|---|---|
| C_0 | Fool | Entry / pioneering step into unworked territory | Entry event is a verified zero; validated crossings earn non-zero | Validation of crossing |
| C_1 | Magician | Building an accepted, real artifact | Delivery bounty on acceptance, sized by scope | Artifact acceptance review |
| C_2 | Priestess | Recording a durable, attributable, findable record | Base credit on publication + usage bonus per verified retrieval | Retrieval verification |
| C_3 | Empress | Nurturing — conditions for another's growth | Multiplier: % of mentee's accepted output, capped per mentee, cycle-gated | Mentee output acceptance (feeds from C_1) |
| C_5 | Hierophant | Teaching, credited on demonstrated competence in another member | Pays on demonstrated ability | Competence demonstration review |
| C_8 | Strength | Resolving a live dispute | Resolution token sized by severity | Non-party resolver assignment; both parties' written acceptance (parallel signature tasks) |
| C_9 | Hermit | Discovering — new understanding steering a real decision | Deep-work bounty at milestones + adoption bonus when finding steers a vote | Decision-steering evidence review |
| C_12 | Hanged Man | Re-seeing — a reframe that changes a real decision | Pays on decision-changed | Decision-delta evidence review |
| C_13 | Death | Ending — chosen, clean closure | Closure token | Preserved-learning review + verified resource release |
| C_15 | Devil | Exposing validated incentive distortion | Integrity bounty (among largest); corroboration required | Corroborator task; false-claim penalty gateway |
| C_16 | Tower | Responding to verified crisis/collapse | Crisis token sized by severity; pays stabilization, not detection | Crisis verification (via C_18), severity sizing |
| C_18 | Moon | Verifying — resolving pending claims | Verification token per completed check, regardless of direction | Verification-check task; accuracy-vs-chance tracking |

### Extrapolated (10) — complete workflows proposed from spec logic, tagged "proposed interpretation — spec gap, pending DAO ratification"

| Dim | Name | Function | Proposed payment logic / human gate |
|---|---|---|---|
| C_4 | Emperor | Adopted rule changes | Governance bounty on adopted change after ratification vote (human vote) |
| C_6 | Lovers | Genuine joint builds | Shared delivery bounty on accepted joint artifact, split by verified attribution |
| C_7 | Chariot | Milestones, net-of-harm | Milestone token on verified milestone completion, harm-adjusted |
| C_10 | Wheel | Fair cycle completion | Cycle-completion credit on audited fair cycle close |
| C_11 | Justice | Audits / calibration | Audit token per completed fairness audit (human-only during bootstrap) |
| C_14 | Temperance | Health metric held in range, with stall detection | Holding credit per in-range interval; stall detection gateway |
| C_17 | Star | Orientation | Onboarding credit when orientee completes first verified contribution |
| C_19 | Sun | Public recognition tied to verified records | Recognition credit only when tied to a verified record |
| C_20 | Judgement | End-of-cycle reckoning, provenance settlement | Reckoning credit on settled provenance (human-only during bootstrap) |
| C_21 | World | Completion of the whole | Completion credit on verified whole-cycle completion |

## Artifact set

```
docs/contribution-economy/
├── index.html                     ← presentation page (bpmn-js renders + explanations)
├── bpmn/
│   ├── 00-master-lifecycle.bpmn
│   ├── 20-interaction-map.bpmn
│   ├── 21-aggregation-rct.bpmn
│   └── c00-fool.bpmn … c21-world.bpmn   (22 files)
└── README.md                      ← markdown index with Mermaid mirrors
```

Images (SVG/PNG) are exported from bpmn-js rendering of the same BPMN source — no hand-drawn diagrams.

### 00-master-lifecycle.bpmn

Swimlanes: Member | Evidence Layer | Classifier | Verification | Balance Engine | Cycle Operators.

Flow: action → provenance check + evidence record (C_2 rails) → classification proposes `P(a)` → tiered verification (Tier 0 automatic; Tier 1 machine-proposed + random audit; Tier 2 two independent human reviewers with conflict checks and written reasons; Tier 3 rotating appeal panel) → harm check → delta formula → 22 balances → cycle boundary (Wheel/Judgement/World) → `$RCT` aggregation.

Modeling details:
- Null/zero gateway: no evidence ≠ verified zero.
- Escalation gateway per tier: conflict-of-interest check, written-reasons user task, appeal-with-deadline boundary event.
- Explanation-record task emitted by every decision.

### Per-dimension BPMN template (22 files)

Common skeleton: trigger event → evidence requirement → human interaction gate(s) (explicit User Tasks with responsible role) → payment rule (outcome-verified only) → anti-gaming gate → balance delta → cross-dimension outputs (message flows).

Anti-gaming gates per dimension follow the spec's named failure modes and countermeasures (metric capture, conflict farming, closure theater, Sybil entry, reviewer capture, AI-leverage capture).

### 20-interaction-map.bpmn

Three bands:
- **Rails:** C_2 (record layer feeds evidence for all), C_18 (verifies all pending claims), C_4 (rule changes), C_11 Justice (calibration/audit), C_15 Devil (audits all dimension weights).
- **Flow dependencies:** C_3→C_1 (multiplier needs mentee's accepted artifact), C_9/C_12→voting decisions (adoption/decision-changed bonuses), C_13→resource release→C_14 health metric, C_16→C_18 crisis verification, C_5→C_3 (demonstrated competence = nurture evidence), C_17→C_0 (orientation feeds entry).
- **Cycle spine:** C_10 → C_20 → C_21 → `$RCT` aggregation; C_19 and C_17 continuous.

README includes a cross-dependency table: source dimension → target → what flows (evidence, verification, multiplier input, calibration).

### 21-aggregation-rct.bpmn

Swimlanes: Balance Engine | Normalization | Governance (human) | Publication.

1. Cycle boundary event (fired by C_10 completion + C_20 provenance settlement confirmed).
2. Per dimension (0–21): fetch `C_i` → null-preserving normalization `N_i` → exclusion check (capital-derived portions removed from voting-relevant aggregation).
3. Human governance gateway: `alpha_i` weight review + versioning — User Task with C_11 fairness-audit precondition (under-recognized care/mediation/maintenance) and C_15 distortion-audit precondition; changed weights emit calibration-version explanation record.
4. Aggregate `$RCT = aggregate(alpha_i × N_i(C_i))` → profile-preserved check (RCT summarizes, never erases the 22-vector).
5. Use-gate XOR gateway: `$RCT` gates eligibility/quorum only; rejects any path scaling voting weight (voting weight = human-attributed portions in question-declared salient dimensions, hard caps).
6. Publish summary + update 22-vector as source record (parallel join).

### index.html

- Loads BPMN XML and renders each diagram via bpmn-js (CDN script, no build step); pan/zoom and clickable elements.
- Sections: overview (22-dimension table), master lifecycle, 22 dimension cards (each with badge: *specified* or *proposed interpretation*, plus human-interaction list), interaction map, `$RCT` workflow, anti-gaming summary.
- Each card: bpmn-js canvas + explanation (trigger, human gates, payment rule, cross-dimension outputs) + static image fallback.
- Images exportable from bpmn-js for presentation use.

### README.md

Markdown index with Mermaid mirrors of each diagram (render on GitHub; no-JS fallback) and the cross-dependency table.

## Error handling / spec gaps

- The 10 extrapolated dimensions are marked as proposed interpretation in the HTML page and README; nothing in the diagrams claims DAO ratification.
- Diagrams model unresolved judgment as "pending — settles retroactively when evidence arrives" (per spec), never as a silent drop.
- Chronic under-measurement path: back-pay / calibration / rule retirement gateway in the aggregation workflow.

## Validation

- Each `.bpmn` file validates as BPMN 2.0 (bpmn-js import without errors, bpmn-moddle parse check).
- HTML page renders all 25 diagrams in a browser (verify locally).
- Cross-dimension arrows in the interaction map match the README dependency table 1:1.
- Spec invariants checklist reviewed per diagram (null-preservation, outcome-only payment, human gates present, RCT never scales votes).