# ResonantDAO — Contribution Economy Workflows (BPMN 2.0)

This directory contains BPMN 2.0 models of the ResonantDAO contribution economy: the 22 contribution dimensions (Major Arcana, C_0–C_21), their cross-dimension interactions, and the $RCT aggregation workflow that summarizes them. The models mirror the design spec at [`docs/superpowers/specs/2026-09-16-contribution-economy-workflows-design.md`](../superpowers/specs/2026-09-16-contribution-economy-workflows-design.md) and the source page at https://resonantdao.com/contribution-economy/ .

**How to view:** open `index.html` in a browser (or serve this directory with `python3 -m http.server` and browse to the served page). Diagrams also validate structurally via `npm run validate`.

## File index

| File | Diagram | Badge | One-line function |
| --- | --- | --- | --- |
| `bpmn/00-master-lifecycle.bpmn` | Master Contribution Lifecycle | `core` | Action → evidence → classification P(a) → tiered verification (T0–T3) → harm check → delta formula → 22 balances → cycle boundary → $RCT aggregation. |
| `bpmn/20-interaction-map.bpmn` | Dimension Interaction Map | `core` | Rails (C_2 records, C_18 verification, C_4 rules, C_11 audits, C_15 distortion audits) + cross-dimension flow dependencies + cycle spine C_10 → C_20 → C_21 → aggregation. |
| `bpmn/21-aggregation-rct.bpmn` | $RCT Aggregation Workflow | `core` | Cycle boundary → null-preserving normalization N_i → capital-portion exclusion → human governance of alpha_i → aggregate → use gate (eligibility/quorum only, never vote scaling) → publish + update 22-vector. |
| `bpmn/c00-fool.bpmn` | C_0 Fool — Entry | `specified` | Entry/pioneering step. Entry event is a verified zero; validated crossings earn non-zero value. |
| `bpmn/c01-magician.bpmn` | C_1 Magician — Building | `specified` | Delivery bounty on acceptance, sized by scope; never on submission. |
| `bpmn/c02-priestess.bpmn` | C_2 Priestess — Recording | `specified` | Base credit on publication + usage bonus per verified retrieval. Evidence rails for all dimensions. |
| `bpmn/c03-empress.bpmn` | C_3 Empress — Nurturing | `specified` | Multiplier: percentage of mentee's accepted output, capped per mentee, cycle-gated. |
| `bpmn/c04-emperor.bpmn` | C_4 Emperor — Rule Changes | `proposed interpretation` | Governance bounty on adopted rule change after ratification vote; proposal alone pays nothing. |
| `bpmn/c05-hierophant.bpmn` | C_5 Hierophant — Teaching | `specified` | Pays on demonstrated competence in another member; lectures and attendance pay nothing. |
| `bpmn/c06-lovers.bpmn` | C_6 Lovers — Joint Builds | `proposed interpretation` | Shared delivery bounty on accepted joint artifact, split by verified attribution. |
| `bpmn/c07-chariot.bpmn` | C_7 Chariot — Milestones | `proposed interpretation` | Milestone token on verified milestone, net-of-harm. |
| `bpmn/c08-strength.bpmn` | C_8 Strength — Resolving | `specified` | Resolution token sized by severity; requires non-party resolver and both parties' written acceptance. |
| `bpmn/c09-hermit.bpmn` | C_9 Hermit — Discovering | `specified` | Deep-work bounty at milestones + adoption bonus when a finding steers a vote; never on length. |
| `bpmn/c10-wheel.bpmn` | C_10 Wheel — Fair Cycle Completion | `proposed interpretation` | Cycle-completion credit on audited fair cycle close; fires the aggregation boundary event. |
| `bpmn/c11-justice.bpmn` | C_11 Justice — Audits / Calibration | `proposed interpretation` | Audit token per completed fairness audit; human-only during bootstrap; triggers back-pay/calibration on under-recognition. |
| `bpmn/c12-hanged-man.bpmn` | C_12 Hanged Man — Re-seeing | `specified` | Pays on decision-changed; never on pause duration. |
| `bpmn/c13-death.bpmn` | C_13 Death — Ending | `specified` | Closure token requiring preserved learning and verified resource release; feeds C_14. |
| `bpmn/c14-temperance.bpmn` | C_14 Temperance — Health in Range | `proposed interpretation` | Holding credit per in-range interval with stall detection; consumes resources released by C_13. |
| `bpmn/c15-devil.bpmn` | C_15 Devil — Exposing | `specified` | Integrity bounty, among the largest payouts; corroboration required; false claims penalized. |
| `bpmn/c16-tower.bpmn` | C_16 Tower — Crisis Response | `specified` | Crisis token sized by severity; pays stabilization, not detection or caused failure. |
| `bpmn/c17-star.bpmn` | C_17 Star — Orientation | `proposed interpretation` | Onboarding credit when orientee completes first verified contribution; attendance alone pays nothing. |
| `bpmn/c18-moon.bpmn` | C_18 Moon — Verifying | `specified` | Verification token per completed check regardless of direction; accuracy tracked against chance. |
| `bpmn/c19-sun.bpmn` | C_19 Sun — Public Recognition | `proposed interpretation` | Recognition credit only when tied to a verified record. |
| `bpmn/c20-judgement.bpmn` | C_20 Judgement — Reckoning | `proposed interpretation` | End-of-cycle reckoning and provenance settlement; unresolved judgments stay pending and settle retroactively. |
| `bpmn/c21-world.bpmn` | C_21 World — Completion | `proposed interpretation` | Completion credit on verified whole-cycle completion; closes the cycle spine into aggregation. |

## Cross-dimension dependencies

| Source | Target | What flows |
| --- | --- | --- |
| C_2 Priestess | C_0, C_1, C_5, C_9, C_19 | evidence records |
| C_18 Moon | C_16, C_8, C_13 | verification verdicts for pending claims |
| C_1 Magician | C_3 Empress | mentee's accepted artifact (multiplier input) |
| C_5 Hierophant | C_3 Empress | demonstrated competence as nurture evidence |
| C_9 Hermit | C_20 Judgement | decision-steering evidence (adoption bonus) |
| C_12 Hanged Man | C_20 Judgement | decision-changed evidence |
| C_13 Death | C_14 Temperance | released resources feed health metric |
| C_17 Star | C_0 Fool | orientation feeds entry |
| C_17 Star | C_1 Magician | orientee's first verified contribution |
| C_15 Devil | C_11 Justice + 21-aggregation-rct | weight distortion findings |
| C_11 Justice | 21-aggregation-rct | calibration updates + fairness audit |
| C_10 Wheel | C_20 Judgement | fair cycle close |
| C_20 Judgement | C_21 World | settled provenance |
| C_21 World | 21-aggregation-rct | whole-cycle completion |
| C_4 Emperor | 21-aggregation-rct | adopted rules / calibration versions |
| C_19 Sun | C_2 Priestess | recognition must tie to verified record |
| C_16 Tower | C_18 Moon | crisis verification request |

## Master lifecycle mirror

```mermaid
flowchart LR
  S([Member performs action]) --> E[Record evidence: action, context, provenance, outcome]
  E --> PV{Provenance valid?}
  PV -->|no| REJ([No evidence - null stays null, never 0])
  PV -->|yes| CL[Classify: sparse vector P a = p_0..p_21]
  CL --> TI{Review tier}
  TI -->|Tier 0| T0[Automatic verification]
  TI -->|Tier 1| T1[Machine-proposed check] --> T1A[Random audit sample]
  TI -->|Tier 2| T2[Conflict-of-interest check] --> T2A[Reviewer 1: written reasons] & T2B[Reviewer 2: written reasons]
  T0 --> V{Verified?}
  T1A --> V
  T2A --> V
  T2B --> V
  V -->|no| AP[Appeal: deadline-bound, Tier 3 panel] --> V
  V -->|yes| H[Harm check: verified harm reduces or voids outcome]
  H --> D[Delta C_i = Match x Outcome x Verification x Calibration_i]
  D --> B[(22 non-transferable balances)]
  B --> R[Emit explanation record]
  R --> CY((Cycle boundary: C_10 -> C_20 -> C_21))
  CY --> RCT[Aggregate \$RCT - see 21-aggregation-rct]
  RCT --> END([Balances updated - 22-vector remains source record])
```

## $RCT aggregation mirror

```mermaid
flowchart LR
  S(([Cycle boundary: C_10 fair close + C_20 provenance settled])) --> N[Normalize N_i C_i - null preserving, null never becomes 0, never decays]
  N --> X{Capital-derived portion?}
  X -->|yes| EX[Exclude from voting-relevant aggregation] --> W
  X -->|no| W[Human governance: review alpha_i weights + version]
  FA[C_11 Justice fairness audit] --> W
  DA[C_15 Devil distortion audit] --> W
  W --> CV[Emit calibration-version explanation record]
  CV --> A[Aggregate: RCT = aggregate alpha_i x N_i C_i]
  A --> P{Profile preserved - RCT summarizes, never erases?}
  P -->|no| A
  P -->|yes| U{Use gate}
  U -->|eligibility / quorum only| PUB[Publish summary + update 22-vector] --> DONE([Cycle settled])
  U -.->|FORBIDDEN: scale voting weight| STOP([Rejected - RCT never scales votes])
```

## Per-dimension mirrors

Mirrors of each dimension model's actual flow: start event → evidence/gate tasks → gateways with branch labels → payment task → explanation record → feed tasks → end events.

### C_0 Fool — Entry

```mermaid
flowchart LR
  S([Entry into unworked territory]) --> EV[Submit entry evidence] --> G1{Sybil check passed?}
  G1 -->|no| E1([No entry credit - Sybil])
  G1 -->|yes| RV[Validate crossing - reviewer] --> G2{Crossing validated?}
  G2 -->|no| E2([Entry event = verified zero - recorded - no payment])
  G2 -->|yes| RC[Emit explanation record] --> F17[Feed C_17 Star - orientation progress] --> E3([Validated crossing earns value])
```

### C_1 Magician — Building

```mermaid
flowchart LR
  S([Artifact submitted]) --> EV[Submit evidence] --> PR[Provenance check]
  PR --> AC[Review and accept - Tier 2] --> G{Accepted?}
  G -->|yes| SC[Size bounty by scope] --> RC[Explanation record] --> F3[Feed C_3 Empress] --> PAID([Delivery bounty])
  G -->|no| NONE([No bounty - submission pays nothing])
```

### C_2 Priestess — Recording

```mermaid
flowchart LR
  S([Record published]) --> G1{Durable - attributable - findable?}
  G1 -->|no| E1([Not a record - no credit])
  G1 -->|yes| BASE[Base credit on publication] --> RET[Verify retrieval - usage bonus per verified retrieval] --> G2{More verified retrievals?}
  G2 -->|yes| RET
  G2 -->|no| G3{Attributable and findable?}
  G3 -->|no| E2([No credit])
  G3 -->|yes| RC[Emit explanation record] --> RAILS[Rails for all dimensions - evidence records] --> E3([C_2 balance updated])
```

### C_3 Empress — Nurturing

```mermaid
flowchart LR
  S([Mentee accepted output from C_1]) --> G1{Cap per mentee respected?}
  G1 -->|no| E1([No multiplier - cap exceeded])
  G1 -->|yes| G2{Cycle gate open?}
  G2 -->|no| E2([Deferred to next cycle])
  G2 -->|yes| V[Verify mentee output acceptance] --> G3{Conflict-farming check passed?}
  G3 -->|no| E3([Rejected - conflict farming])
  G3 -->|yes| M[Nurture multiplier - percentage of mentee accepted output] --> RC[Emit explanation record] --> E4([C_3 balance updated])
```

### C_4 Emperor — Rule Changes

```mermaid
flowchart LR
  S([Rule change proposed]) --> D[Draft rule change] --> V[Ratification vote] --> G{Adopted?}
  G -->|no| E1([No bounty - proposal alone pays nothing])
  G -->|yes| B[Governance bounty on adopted change] --> RC[Emit explanation record] --> FA[Feed aggregation - adopted rule to calibration version] --> E2([C_4 balance updated])
```

### C_5 Hierophant — Teaching

```mermaid
flowchart LR
  S([Teaching claimed]) --> G1{Lecture or attendance only?}
  G1 -->|yes| E1([No credit - never pays on lectures or attendance])
  G1 -->|no| RV[Review demonstrated competence in another member] --> CC[Competence credit] --> RC[Emit explanation record] --> F3[Feed C_3 Empress - competence as nurture evidence] --> E2([C_5 balance updated])
```

### C_6 Lovers — Joint Builds

```mermaid
flowchart LR
  S([Joint build declared]) --> D[Declare joint build with attribution shares] --> RV[Review genuine joint contribution + verified attribution] --> G{Conflict farming check passed?}
  G -->|no| E1([Rejected - conflict farming])
  G -->|yes| B[Shared delivery bounty split by verified attribution] --> RC[Emit explanation record] --> F1[Feed C_1 Magician - joint artifact acceptance] --> E2([C_6 balance updated])
```

### C_7 Chariot — Milestones

```mermaid
flowchart LR
  S([Milestone plan committed]) --> V[Verify milestone completion] --> G1{Harm detected - verified?}
  G1 -->|yes| H[Net-of-harm adjustment - reduce or void outcome] --> M
  G1 -->|no| M{Merge paths}
  M --> T[Milestone token] --> RC[Emit explanation record] --> F14[Feed C_14 Temperance - milestone health context] --> E1([C_7 balance updated])
```

### C_8 Strength — Resolving

```mermaid
flowchart LR
  S([Live dispute opened]) --> F1{Fork}
  F1 --> A[Assign non-party resolver]
  F1 --> NV[Verify resolver is not a party]
  A --> F2{Join}
  NV --> F2
  F2 --> G1{Resolver qualified?}
  G1 -->|no| E1([Resolver disqualified])
  G1 -->|yes| T[Resolution token sized by severity] --> F3{Fork}
  F3 --> PA[Party A written acceptance]
  F3 --> PB[Party B written acceptance]
  PA --> F4{Join}
  PB --> F4
  F4 --> G2{Both acceptances received?}
  G2 -->|no| E2([No resolution token - both acceptances required])
  G2 -->|yes| RC[Emit explanation record] --> F18[Feed C_18 Moon - resolution record for verification] --> E3([C_8 balance updated])
```

### C_9 Hermit — Discovering

```mermaid
flowchart LR
  S([Research finding delivered]) --> MR[Milestone evidence review] --> DW[Deep-work bounty at milestones] --> G1{Payment trigger = milestone?}
  G1 -->|no| E1([No bounty - never pays on length])
  G1 -->|yes| G2{Finding steers a vote?}
  G2 -->|yes| V[Verify decision-steering evidence] --> AB[Adoption bonus] --> M
  G2 -->|no| M{Merge paths}
  M --> RC[Emit explanation record] --> F20[Feed C_20 Judgement - adoption evidence] --> E2([C_9 balance updated])
```

### C_10 Wheel — Fair Cycle Completion

```mermaid
flowchart LR
  S([Cycle end reached]) --> FA[Fairness audit of cycle - human] --> G{Cycle fair?}
  G -->|no| LOG[Log cycle debt - measurement failure is the system debt] --> E1([Retrial next cycle])
  G -->|yes| CC[Cycle-completion credit] --> RC[Emit explanation record] --> FIRE[Fire cycle-boundary event to 21-aggregation-rct] --> E2([C_10 balance updated])
```

### C_11 Justice — Audits / Calibration

```mermaid
flowchart LR
  S([Audit scheduled]) --> FA[Execute fairness audit - human-only bootstrap] --> T[Audit token per completed audit] --> G{Under-recognition in care - mediation - maintenance?}
  G -->|yes| BP[Trigger back-pay / calibration / rule retirement] --> M
  G -->|no| M{Merge paths}
  M --> RC[Emit explanation record] --> E1([C_11 balance updated])
```

### C_12 Hanged Man — Re-seeing

```mermaid
flowchart LR
  S([Reframe proposed]) --> G1{Pause duration only?}
  G1 -->|yes| E1([No credit - never pays on pause])
  G1 -->|no| RV[Review decision-delta evidence] --> G2{Decision actually changed?}
  G2 -->|no| E2([No decision change - no credit])
  G2 -->|yes| C[Decision-changed credit] --> RC[Emit explanation record] --> F20[Feed C_20 Judgement - decision-change record] --> E3([C_12 balance updated])
```

### C_13 Death — Ending

```mermaid
flowchart LR
  S([Closure chosen]) --> F1{Fork}
  F1 --> PL[Review preserved learning]
  F1 --> RR[Verify resource release]
  PL --> F2{Join}
  RR --> F2
  F2 --> G{Real closure - not abandonment?}
  G -->|no| E1([Rejected - closure theater])
  G -->|yes| T[Closure token] --> RC[Emit explanation record] --> F14[Feed C_14 Temperance - released resources] --> E2([C_13 balance updated])
```

### C_14 Temperance — Health in Range

```mermaid
flowchart LR
  S([Health metric monitoring cycle]) --> G1{Metric in range?}
  G1 -->|yes| H[Holding credit per in-range interval] --> RC[Emit explanation record] --> CONS[Consumes resources released by C_13 Death] --> E1([C_14 balance updated])
  G1 -->|no| G2{Stall detected?}
  G2 -->|yes| SR[Stall remediation - human] --> G1
  G2 -->|no| E2([No credit - out of range])
```

### C_15 Devil — Exposing

```mermaid
flowchart LR
  S([Incentive distortion claim filed]) --> COR[Corroboration by independent member - at least 1] --> G{Claim corroborated?}
  G -->|no| FP[False-claim penalty] --> E1([Penalty applied])
  G -->|yes| AUD[Devil operator audit of weights - human-only bootstrap] --> B[Integrity bounty - among the largest payouts] --> RC[Emit explanation record] --> F11[Feed C_11 Justice + aggregation - distortion finding] --> E2([C_15 balance updated])
```

### C_16 Tower — Crisis Response

```mermaid
flowchart LR
  S([Crisis event detected]) --> V[Verify crisis via C_18 Moon] --> G1{Crisis verified?}
  G1 -->|no| E1([No token - detection alone pays nothing])
  G1 -->|yes| G2{Caused by responder own failure?}
  G2 -->|yes| E2([No token - caused failure])
  G2 -->|no| SZ[Size token by severity] --> T[Crisis token for stabilization] --> RC[Emit explanation record] --> F13[Feed C_13 Death - stabilization record] --> E3([C_16 balance updated])
```

### C_17 Star — Orientation

```mermaid
flowchart LR
  S([New member oriented]) --> O[Orientation session - human] --> G1{Attendance only?}
  G1 -->|yes| E1([No credit - attendance pays nothing])
  G1 -->|no| G2{Orientee completed first verified contribution?}
  G2 -->|no| E2([Pending - no credit yet])
  G2 -->|yes| C[Onboarding credit] --> RC[Emit explanation record] --> F0[Feed C_0 Fool - entry progress] --> E3([C_17 balance updated])
```

### C_18 Moon — Verifying

```mermaid
flowchart LR
  S([Pending claim enqueued]) --> G1{More pending claims?}
  G1 -->|no| E1([Queue drained])
  G1 -->|yes| V[Complete verification check] --> T[Verification token per completed check - any direction] --> ACC[Track accuracy vs chance] --> G2{Reviewer capture suspected?}
  G2 -->|yes| ROT[Rotate reviewer pool - Tier 3] --> G1
  G2 -->|no| RC[Emit explanation record] --> F[Verdicts feed all dimensions pending claims] --> E2([C_18 balance updated])
```

### C_19 Sun — Public Recognition

```mermaid
flowchart LR
  S([Recognition nomination]) --> G{Tied to verified record?}
  G -->|no| E1([Rejected - popularity alone pays nothing])
  G -->|yes| RV[Recognition review] --> C[Recognition credit] --> RC[Emit explanation record] --> F2[Feed C_2 Priestess - recognized record link] --> E2([C_19 balance updated])
```

### C_20 Judgement — Reckoning

```mermaid
flowchart LR
  S([Cycle reckoning]) --> PS[Provenance settlement - human-only bootstrap] --> G{Unresolved judgments?}
  G -->|yes| KP[Keep pending - settles retroactively when evidence arrives]
  KP -->|next cycle| G
  G -->|no| C[Reckoning credit] --> RC[Emit explanation record] --> FIRE[Fire aggregation precondition - provenance settled] --> E1([C_20 balance updated])
```

### C_21 World — Completion

```mermaid
flowchart LR
  S([Whole-cycle completion claimed]) --> V[Verify completion of the whole - human] --> G{All cycle dimensions settled?}
  G -->|no| E1([Incomplete - defer])
  G -->|yes| C[Completion credit] --> RC[Emit explanation record] --> CLOSE[Close cycle spine - enable \$RCT publication] --> E2([C_21 balance updated])
```

## Invariants

- Pay on outcome, never on activity — submission, attendance, lecture length, pause duration earn nothing.
- Every action is multi-classified into a sparse weighted vector P(a) = [p_0 … p_21].
- Delta C_i(a) = Match_i × Outcome × Verification × Calibration_i; verified harm reduces or voids the outcome beforehand.
- 22 non-transferable balances.
- Null (no evidence) never becomes 0 (verified zero).
- Null never decays into zero.
- $RCT = aggregate(alpha_i × N_i(C_i)) is a derived summary; the 22-vector remains the source record.
- $RCT may gate eligibility/quorum but never scales votes.
- $RES is a separate transferable token paid only when a class-specific outcome rule fires.
- Voting weight draws only from human-attributed portions of balances in question-declared salient dimensions, with hard caps — capital-derived contribution never becomes voting power.
- Every decision emits an explanation record.
- Measurement failure is the system's debt, never the contributor's.

## Badge note

The 10 `proposed interpretation` dimensions are extrapolated from the spec's payment/anti-gaming logic and are pending DAO ratification. The 12 `specified` dimensions and the 3 `core` diagrams derive directly from the spec page.