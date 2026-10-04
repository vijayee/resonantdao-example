# Contribution Wizard & Data Model — Design

Date: 2026-10-03
Status: approved design, pending implementation plan
Supersedes (extends): 2026-09-16-contribution-economy-workflows-design.md (BPMN conceptual model)
Depends on: 2026-09-30-replace-timed-allocation-contribution-workflow.md (phase-1 payment lifecycle)

## Purpose

Contributions need a Wizard: a guided, multi-step UI where the steps derive from the contribution's dimensions (of the 22) and each participant sees the steps relevant to their role. This design defines:

1. The contribution **data model** — what lives in the CRABS state machine vs out-of-band storage.
2. The **step schema** system that determines wizard steps per dimension.
3. How **role-based views** derive from replicated facts without storing per-role state.
4. The wizard's client orchestration and server content store.

## Decisions (locked 2026-10-03)

- **D1 — Generic step schema, few wired:** One generic step-schema data model, expressive enough for all 22 BPMN flows (including multi-party shapes like C_8 Strength's dual written acceptance), but only C_1 Magician, C_2 Priestess, and C_18 Moon get wired schemas in phase 1; all other dimensions use a default `submit → verify` schema.
- **D2 — CRABS is a fact ledger, not a database:** CRABS holds the consensus essence of a contribution (fact record, lifecycle counters, verdicts, payments, explanation records, evidence *pointer*). Bulky content (drafts, attachments, media) lives in a server-side content-addressed store, referenced by hash from CRABS. This mirrors the BPMN model's C_2 Priestess band: the record layer feeds evidence to all dimensions but is separate from the balance engine.

## Rationale: why facts-only

CRABS converges by executing the same signed ops on every replica, persists every op byte in the WaveDB log, and replays the log on restart. Every payload byte is replicated N times and replayed forever. A contribution's consensus essence is hundreds of bytes; content is megabytes. Storing content in CRABS would multiply it across all replicas and the op log for no consensus benefit — content does not need CRABS' convergence property, only its integrity does (via the hash pointer).

## What lives where

### In CRABS (replicated, consensus)

Per contribution (keyed by `contributionId`):

| Holding | Type | Content |
| --- | --- | --- |
| Fact record | element in `contributions` ORSet (tag = submitter) | `{contributionId, submitter, dims, summary, evidenceRef, schemaVersion}` JSON, ≤ ~1KB |
| Lifecycle position | register | `contrib:{id}:step` — current step index into the dimension's ordered schema |
| Step completion | PNCounter | `contrib:{id}:{stepId}:done` — completed requirements for that step |
| Status | register | `contrib:{id}:st` — pending / accepted / rejected (retained from phase-1 plan) |
| Explanation records | ORSet | `contrib:{id}:e` — one JSON record per decision (submit, each step completion, verdict, payments) with calibration/schema versions |

The evidence reference: `{hash: sha256-hex, uri, mediaType, size}` — pointer, not content.

### In code, replicated as bytes (not state)

**Step schemas** live in `shared/src/contribution.ts` alongside `DIMENSIONS`. Because schemas are static code shipped to every replica, handlers can consult them deterministically — wizard steps need no storage, and schema interpretation is identical on every replica.

```typescript
interface StepDef {
  stepId: string;
  title: string;
  requirement: { mode: 'single' | 'all-parties' | 'majority'; count: number };
  actors: ('submitter' | 'verifier' | 'custodian' | 'member')[];
  op: string;   // op type that completes one requirement
  pays?: Array<{ who: 'submitter' | 'actor'; rule: 'per-dims' | 'per-check' | 'flat'; amount?: number }>;
  antiGaming?: ('no-self' | 'written-reason' | 'both-parties')[];
}

interface DimensionSchema {
  dimIndex: number;      // C_0..C_21
  schemaVersion: string; // 'v1'
  steps: StepDef[];      // ordered
}
```

- A **contribution participates in a schema** when its `dims` include a dimension whose schema is wired. Priority when multiple wired dims apply: schema of the lowest `dimIndex` (deterministic, documented). Non-wired dimensions still receive tally deltas at the wired schema's payment steps (a C_9 claim verified under the default schema still pays nothing but records its match weight — consistent with "classification-only").
- The **default schema** (for the 19 unwired dimensions): `submit (submitter) → verify (verifier, per-check credit) → settle`. Verified acceptance of a class-only contribution records dimension tallies with zero payment.

- **Wizard model** (`shared/src/wizard.ts` — new module importing from `./contribution`): a pure function
  `wizardModel(schema, contribFacts, viewerId) → { contributionId, currentStepIndex, steps: [{ stepId, title, state: 'complete' | 'current' | 'locked' | 'settled', roles: { [role]: { mayAct: boolean; op: string; label: string } } }] }`.
  State derivation: steps before current are complete; the first step with `done < requirement.count` is current; later steps locked; schema-final state → settled (with status accepted/rejected). Role views: `mayAct` is true when the viewer matches the step's actor list and the step is current; CRABS policies remain the enforcement layer — wizard views only *offer* actions.

### Out of band (server-only)

**Content store** — a generalization of the existing WaveDB snapshot mechanism into content-addressed objects:

- `put_content` (WS op): server computes sha-256 of the bytes, stores under `content/{hash}` in WaveDB (idempotent on repeat puts), returns `{hash}`.
- `get_content` (WS op): fetches by hash; any member may read (same PoC trust as snapshots today).
- Caps: 8MB per object; a contribution may reference at most 16 objects. Client flow: upload content first, then `submit_contribution` with `evidenceRef = {hash, uri: 'content://{hash}' mediaType, size}`. CRABS handlers validate the reference's *shape and hash format* only — never the content.

## Op and handler changes

- `submit_contribution` (from the phase-1 plan) is extended: payload carries `evidenceRef` and `schemaVersion`; handler consults the schema registry to snapshot the contribution's lifecycle (init step counters).
- `verify_contribution` becomes the generic first-class step op: handler (1) resolves the contribution's schema, (2) validates the op matches the current step (`stepId`, actor eligibility, requirement not yet satisfied), (3) bumps `contrib:{id}:{stepId}:done`, (4) on the step's final requirement fires the step's payment hook (`paymentFor` for submitter dims; flat/per-check for step actors), (5) appends an explanation record, (6) advances `contrib:{id}:step` when the step completes (and flips `st` on the terminal step).
- Anti-gaming flags are enforced in handlers: `no-self` (verifier ≠ submitter), `written-reason` (non-empty reason required), `both-parties` (requirement mode all-parties — expressible now, wired when C_8's schema ships).
- Multi-step schemas (phase 2+) may add more op types; the model is that one op type maps to one `StepDef.op`.

## Wizard UI (client)

- A contribution detail view renders `wizardModel` output: stepper header with per-step state, and a body panel per current step.
- Per role on the current step: submitter sees progress + what's needed next; verifier/member actors get action affordances (verify with written reason); custodians see custodian gates; everyone else a read-only summary.
- Submitters create contributions through the submit form; evidence files/sizes over the inline limit upload to the content store first (getting a hash), smaller inline evidence (URLs, commit ids, short text) bypass the store with `uri` untouched and `hash` of the pointer text.
  Simplification: phase 1 always computes `hash = sha256(evidence bytes or pointer text)` so the reference shape is uniform.
- Status colors/pill: pending → in review (per-step counter i/n) → accepted / rejected; rejected cards keep the explanation record visible (spec: rejected ≠ erased).

## Error handling

- Op on a step that is not current, by an ineligible actor, or exceeding the requirement: rejected (`-1`), same as existing handler rejections; rejected ops are logged and skipped on replay (existing PoC behavior, unchanged).
- Missing evidence content (store returns null): view shows "evidence unavailable"; verification may still proceed against the summary + pointer text — the written-reason gate is what carries the record; content absence is a display concern, not a state-machine concern.
- Unknown/mismatched `schemaVersion` on a fact record: contribution renders read-only (no actions offered) and the mismatch surfaces in the explanation record — never silently dropped (mirrors the spec's "unresolved judgments stay open" principle).
- Content store: duplicate put is idempotent (same hash); oversize/over-count uploads rejected at upload, before any op is signed.

## Testing

- Pure-function unit tests for schema interpretation and `wizardModel` (step transitions, all-parties counting, role eligibility, payment hook selection) — these carry the real logic.
- Handler tests (mock state, per existing pattern): submit/verify through schema-driven progression, prerequisite validation, payment firing at requirement completion, anti-gaming gates.
- Real-wasm policy tests (DaoNode): member-policy enforcement for step ops.
- Hydration test: lifecycle counters, status, and RES/tally registers survive restart via op-log replay.
- Browser e2e (`test-voting-browser.js` extension or successor script): two-browser flow — alice submits with evidence, bob verifies, alice settles, role views differ between the two windows.

## Volume sanity

Per contribution: ~10 registers + 2 counters + ~1KB explanation records; op log grows by one ≤1KB op per milestone. Content (megabytes) never enters the log or CRABS state. At human-work frequencies this is negligible next to existing vote traffic.

## Phase boundaries

- Phase 1 (this design): generic schema model, wired schemas for C_1/C_2/C_18 + default for the rest, content store, wizard UI, single-verifier flow.
- Later phases (separate specs/issues): multi-party schemas (C_8 dual acceptance), tiered verification (Tier 1/3), harm checks, retrieval bonuses, round spine (C_10/C_20/C_21) + $RCT aggregation, null-vs-verified-zero in the 22-vector, reviewer-capture hardening (payload-attested dims/submitter hardening), content-store encryption at rest.

## PoC limitations carried forward

- CRABS gates actions by role via policies but does not hide facts: role-based wizard views control offered actions, not data visibility. Every replica holds every contribution fact.
- `dims`/`submitter` remain payload-attested in step ops (handler state cannot enumerate ORSet elements). Payments and step progression are deterministic across replicas because all replicas recompute from the same payloads against the same schema code.
- Content-store availability depends on the server; integrity (hash) is verifiable but content is not CRABS-replicated.