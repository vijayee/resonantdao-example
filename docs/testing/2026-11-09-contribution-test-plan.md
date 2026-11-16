# Contribution Economy — End-to-End Test Plan

Date: 2026-11-09 · Covers everything implemented through slice #6e + the auth/owner gates ·
How to read: each test lists **Actors → Steps → Expect**. Numbers are exact (the machine's
rules); if a number differs, that's a bug. Run against a FRESH database (§0) so every number
below matches.

---

## 0. Setup

**Fresh run** (recommended — every number in this plan assumes it):

```bash
pkill -f "server/src/index.ts"     # stop any running dev server (careful: exact match)
rm -rf ./data                      # fresh database
npm run dev                        # backgrounds server :9000 + client :5173
```

**Accounts** — register from the login screen (Register tab): `alice`, `bob`, `carol`,
`dave`, `eve` (password: 8+ chars, e.g. `TestPassword123!`). Each account: same browser,
log out between registrations (Logout button top-right).

**Money cheat-sheet** (what the machine pays when):

| Event | Who earns | Amount |
|---|---|---|
| C_1 Building verified-final | the submission's owner | +12 $RES (× harm factor; reduced = ×0.5) |
| C_2 Recording verified-final | the submission's owner | +3 $RES |
| Any verification check completed | the VERIFYING member | +2 $RES (either direction) |
| C_19/C_20/C_21/C_17/C_5 credits | var (see each test) | TALLY only — never $RES |
| Vote costs | the voter | −(quadratic cost) — deducted from $RES |

Weights (`alpha`) default to ×1 per dimension until someone sets them (§11-E).

---

## 1. Auth & landing

**1-A Register → land on the feed**
- Sign in as `alice`.
- **Expect**: you land on the Feed page ("What's happening…"), header shows `alice`, a 🪙 `0 $RES` token balance, RCT `0`.

**1-B Login persistence**
- Log out, log back in as `alice` with the same password.
- **Expect**: same wallet (balances unchanged), land on the feed. A wrong password shows an error, not entry.

**1-C Username hygiene**
- Try registering `victor ` with a trailing space or a zero-width paste; register as `victor`.
- **Expect**: trailing whitespace is trimmed; invisible characters are stripped; the account is `victor`. Registering twice says "Username taken".

---

## 2. C_1 Magician — Building (the full lifecycle)

**2-A Submit a building claim**
- `alice` → Contribute → **Start a new contribution…**
- Wizard: pick **C_1 Magician — Building** → Next → **verifier pick**: tick `bob` (C_1 needs exactly 1... C_1 is single-verify) → Next → summary: `built a bridge` → Next → evidence pointer: `https://example.com/bridge` → Next → review shows Type/Summary/Evidence + **Verifiers: bob** → **Confirm & submit**.
- **Expect**: you are routed to the contribution's own page (`/contribute/<id>`); the pill reads **pending**; phase rail: ✓ Submission — alice, ○ Verification, ○ Settlement.

**2-B Verify it (the named verifier)**
- `bob` → Contribute → alice's row ("built a bridge") → open → the verify form is embedded (Uphold / Reject radio + written reason — a reason is REQUIRED).
- Uphold, reason: `checks out` → Confirm.
- **Expect**: bob's phase shows his check landed (+2 $RES for Bob — see Account §9); the submission's settle step activates for alice.

**2-C Settle**
- `alice` (on the contribution page) → settle note: `paid` → Confirm.
- **Expect**: pill flips to **accepted**; phase rail all ✓; alice's balance +12 $RES (§9).

**2-D The named-verifier lock (anti-gaming)**
- Repeat 2-A as `carol` naming `bob`; while pending, `dave` (unnamed) tries to open carol's contribution.
- **Expect**: dave sees neither the row on /contribute nor the page's verify form — "You're not part of this contribution." (named verifiers only).

---

## 3. C_2 Priestess — Recording + harm

**3-A Record, verify with HARM REDUCED**
- `bob` submits C_2 (`recorded the well's depth`), verifier `carol`.
- `carol` verifies: choice **Uphold, harm reduced**, reason required.
- **Expect**: settle → accepted; bob earns **+1.5 $RES** (base credit 3 × the 0.5 harm factor); the contribution page shows a harm line: "accepted — credit 1.5 (harm reduced)".

**3-B Voided**
- Another C_2 by `carol` verified with **Void**.
- **Expect**: accepted with outcome voided — **no $RES** moves for the submission; the harm line says "outcome voided (harm)".

**3-C Reciprocity bar**
- Verify the same pair a second time (bob verifies carol again after carol verified bob once).
- **Expect**: barred — "reciprocity bars re-verification" (each pair works once per round). Use fresh pairs in later tests.

---

## 4. Appeals (the reject → appeal → re-verify → settle arc)

- `carol` submits C_2, verifier `bob` chooses **Reject** ("not findable").
- **Expect**: pill **rejected**; on carol's page an **appeal form** appears (rejected + yours + never appealed).
- `carol` appeals (reason: `the record is findable`).
- **Expect**: pill **appealed**; the verify step re-opens.
- `bob` — wait: bob is reciprocity-barred for this pair post-appeal. **Use reassign**: on carol's page the **reassign flow** (verify slots open) names `dave` → dave sees the claim in his feed band → dave verifies Uphold → carol settles.
- **Expect**: pill **accepted** (+1 credit path); the second verify moved nothing extra (bob's earlier +2 stays; dave earns his own +2).

---

## 5. Targeted verification controls

**5-A Reassign while pending**
- Any pending contribution with verify slots open: the filer's page shows the **reassign flow**; name an additional verifier.
- **Expect**: the named member's attention band lights "awaits your verification"; the machine accepted the op (registered in the feed: "<name> runs orientation…" — wait, that's §7; here: "named … as additional verifier(s)" feed row).

**5-B Verifiers see it in their feed**
- `dave` → Feed → **Needs your attention** lists the contribution awaiting HIS verification.
- **Expect**: the band item is visible only to named verifiers.

**5-C Future stamps reject**
- Attempt a verify from a named member on a claim with a BROKEN tie (skip in manual testing — this is machine-tested; the UI makes the bad claim un-submittable: the tie pick only offers accepted records).

---

## 6. C_19 Sun — Recognition

**6-A Recognize bob's work**
- Prerequisite: bob has an accepted record (§3-A) — the tie evidence. The recognition claim
  is filed by the RECOGNIZER, who ties it to one of their OWN accepted records as evidence,
  and names the member being recognized (the credited party).
- `alice` → Start a new contribution → **C_19 Sun — Public Recognition** →
  **recognized pick**: `bob` → Next → **record pick** (the recognizer's own accepted
  contributions): "built a bridge" → reviewer `dave` → summary `bob's proven well-record` →
  evidence → the review shows **Recognized: bob** + **Tied record: "built a bridge"** → submit.
- `dave` verifies Uphold → settle (like every claim).
- **Expect**: **bob's C_19 tally** (Account → Dimension tallies) reads **C_19 … — 1**; NO
  $RES moves (the recognition credit is a tally, not money); alice's C_19 absent.

**6-B The gate rejects a lie (machine-tested)**
- The wizard only offers accepted records as ties, so a fake tie isn't driverable — the
  machine's gate (record must be ACCEPTED, re-carried ties pinned to the claim's stamps) is
  covered by the jest suite.

---

## 7. C_17 Star — Orientation

**7-A Declare**
- `alice` → Custodians → **Orientation** panel → pick `bob` → submit.
- **Expect**: feed row "alice runs orientation for bob"; **alice's C_17 tally: absent** (attendance alone pays nothing).
- Declaring bob a second time (another guide) → rejected: first-wins.

**7-B First proven work pays the guide**
- Any contribution whose OWNER is bob (bob's own submission from §3-A) completes verification → the moment bob's verify step completes, alice's **C_17 tally: … — 1** (Account → tallies).
- Bob's SECOND contribution verifying → alice's C_17 stays at 1 (first-proven, once).

---

## 8. C_5 Hierophant — Teaching

- `alice` → Start a new contribution → **C_5 Hierophant — Teaching** →
  **taught pick**: `bob` → Next → **record pick**: options = BOB'S accepted contributions ("the student's proven work is the evidence") → pick bob's → reviewer `carol` → summary `taught bob to record wells` → evidence → review shows **Taught: bob** + the tie → submit.
- `carol` verifies Uphold → settle.
- **Expect**: **alice's C_5 tally: … — 1** (the teacher credits); bob's C_5 absent; no $RES.
- The tie is OWNER-PINNED: a claim tying a record NOT authored by the taught member is machine-rejected (the wizard's tie list only offers the taught member's accepted records).

---

## 9. Account page (C_20/C_21 + the ledger)

**9-A Balances & tallies**
- `/account` (Account in the nav): **$RES** and **RCT** chips with hint lines; **Dimension tallies** — nonzero first: alice should carry C_1 (+ the tallies from claims), bob C_19 …, every untouched dimension collapsed into "<n> dimensions untouched".

**9-B The ledger**
- Income lines only: `settled — bounty 12 — "built a bridge"` (alice), `verification check — "…"` (+2, bob/carol/dave). No vote-spend lines, no tally credit lines.

**9-C C_20 + C_21 (the spine's own credits)** — see §10 first.
- After alice drives the round's reckoning: alice's tallies gain **C_20 … — 1**; after completion (publish): **C_21 … — 1**. Driving twice (an appeal-rewound round re-closes) accumulates (2, 2).

---

## 10. The settlement cycle (C_10 → C_20 → C_21)

- Any member → **Round** → the settlement wizard is always there: stage **Open** → **Audit round…** (Fair + note; a reason is required) → stage **Audited** → **Reckoning** (note required; C_20 credit to the driver) → stage **Reckoned** → **Publish** (the review shows "Aggregating N accepted contribution(s)" and a warning if nothing is settled) → stage **Published** → the next round opens.
- **Expect**: each stage chip activates in order; the notes are required; the **RCT badge** on a member updates after publish (round 1 with alice's 12-bounty entry and the claims' tally weights → RCT reflects the aggregation, attributed to the RECIPIENT of each piece of work); weights (Custodians → Weights panel, custodian-only in this build) scale future tally credits (set alpha C_1 = 2 → the NEXT C_1 credit is 24 $RES wait — no: the calibration scales TALLIES; C_1's tally = match × alpha — and RCT aggregation weights too).

**10-D Weights**
- `alice` (first member = custodian in the demo) → Custodians → Weights → set `alpha C_1` = 2, a version label → Set weights.
- **Expect**: subsequent C_1 tally credits double (12-bounty submissions earn C_1 tallies of 2 per match); RCT aggregation reflects it on the next publish.

---

## 11. Proposals, votes, elections (pre-existing, still green)

- Proposals (direct + quadratic with salient dims), voting costs (quadratic — the SECOND vote on the same option costs more and over-spending is REJECTED by the machine with a "Vote error"), runoff, custodian elections (2 cycles), member removal. The header's token balance drops as votes spend.

## 12. Feed page

- **Needs your attention** lists only YOUR actionable items (named verifications, open votes you can cast, orientation claims you drive...); the timeline shows the consequential rows (claims, verdicts, orientations, reassignments) — never votes, never $RES amounts.

## 13. The contribution-economy site (public)

- https://vijayee.github.io/resonantdao-example/ → the contribution-economy page: the 11 implemented workflows carry green **live in the machine** badges + the sidebar's live chips; the README table's "In the machine" column.

---

## Bug-report template

Route + actor + step + what you expected vs saw (+ the browser console if it's a crash + the
server log line if it's a machine rejection).

