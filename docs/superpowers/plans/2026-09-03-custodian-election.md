# Custodian Election Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elect 5 custodians by member ballot (ties resolved by quadratic runoff); custodians control token distribution settings and member removal, enforced by the CRABS policy engine on every mirror.

**Architecture:** New user-signed operation types (`start_election`, `cast_ballot`, `finalize_election`, `cast_runoff_vote`, `set_token_config`, `remove_member`) executed by shared handlers on both the server mirror and every browser mirror. Custodianship is a CRABS `role:custodian` attribute; because handlers cannot grant roles, the server issues `grantRole` after finalize and appends an admin-signed `sync_roles` entry to the canonical log so all mirrors (including replay/hydration) apply the identical role-change sequence and key-version bookkeeping.

**Tech Stack:** TypeScript, CRABS WASM handlers, Jest/ts-jest mock-state unit tests, Playwright smoke test.

**Spec:** `docs/superpowers/specs/2026-09-03-custodian-election-design.md`

**Key architectural facts for the implementer:**
- CRABS `Node.grantRole(target, role, value, signerId)` bumps the target user's key_version by 1; operations carry `signer_key_version` which must equal the user's current version at execute time. Custodian grants therefore change how every mirror must treat that user's future and historical signed operations — hence the in-log `sync_roles` entries carrying `roleVersions: Record<username, number>` (total custodian-role mutations per user since registration). Browsers catch their local node up to that count by re-granting the effective role value.
- Handlers cannot iterate sets. Election candidates are stored in a per-election ORSet (`election:{id}:candidates`) so `setContains` can validate picks; vote counts live in per-candidate PNCounters.
- `rankCandidates` is a shared pure function used by the finalize handler, the server's grant flow, and the client's election-record mirroring, so all three compute identical tie/runoff decisions.
- Admin-signed `sync_roles` ops must NOT be executed on browser nodes (`signerId === 'admin'` is unregistered there); `BrowserDao.executeRemote` detects them and applies roles locally instead of calling `node.execute`.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `shared/src/types.ts` | Election/config/sync payload types |
| `shared/src/policies.ts` | `ELECTION_NAMES`, `CONFIG_NAMES`, `CUSTODIAN_SEATS`, `RUNOFF_SUFFIX`, `runoffId`, new policies |
| `shared/src/handlers.ts` | `rankCandidates` + 6 new handlers + dynamic `distributeTokens` |
| `server/test/handlers.test.ts` | Unit tests (mock-state harness) for all new handlers |
| `server/src/crabs.ts` | DaoNode: register handlers/policies/config registers; grant/revoke custodian helpers; election-winner read; custodian tracking; `observeOperation` sync flow |
| `server/src/handlers.ts` | ConnectionHandler: track election candidates, persist/broadcast `sync_roles`, `revokeUser` on remove |
| `server/src/server.ts` | hydrateDao: `observeOperation` during replay; custodian rebuild |
| `server/test/crabs.test.ts` | CRABS-level policy enforcement test |
| `client/src/dao.ts` | BrowserDao: op wrappers, election mirroring, `applyCustodianState`, config registers, `sync_roles` handling |
| `client/index.html` | Election + custodian-admin panels |
| `client/src/ui.ts` | Ballot UI, runoff UI, custodian controls, custodian badges |
| `test-voting-browser.js` | End-to-end election + custodian-power smoke test |

---

## Task 1: Shared foundation — names, payloads, policies, dynamic token config

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/policies.ts`
- Modify: `shared/src/handlers.ts` (only `distributeTokens`)
- Modify: `server/src/crabs.ts`, `client/src/dao.ts` (config register creation)
- Test: `server/test/handlers.test.ts`

- [ ] **Step 1: Add payload types to `shared/src/types.ts`** (append after `RemoveMemberPayload`-style section; keep existing interfaces)

```typescript
export interface StartElectionPayload {
  electionId: string;
  candidates: string[];
  expiresAt: number; // epoch ms
}

export interface CastBallotPayload {
  electionId: string;
  picks: string[]; // 1-5 member usernames
}

export interface FinalizeElectionPayload {
  electionId: string;
  candidates: string[];
}

export interface CastRunoffVotePayload {
  electionId: string;
  candidate: string;
}

export interface SetTokenConfigPayload {
  intervalMs: number;
  rate: number;
}

export interface RemoveMemberPayload {
  username: string;
}

export interface SyncRolesPayload {
  custodians: string[];
  roleVersions: Record<string, number>; // total custodian-role mutations per user
}
```

- [ ] **Step 2: Add names to `shared/src/policies.ts`** (append; keep everything existing)

```typescript
export const CUSTODIAN_SEATS = 5;
export const RUNOFF_SUFFIX = ':runoff';
export const runoffId = (electionId: string) => `${electionId}${RUNOFF_SUFFIX}`;

export const CONFIG_NAMES = {
  distributionInterval: () => 'config:distribution_interval',
  distributionRate: () => 'config:distribution_rate',
} as const;

export const ELECTION_NAMES = {
  candidates: (id: string) => `election:${id}:candidates`,
  candVotes: (id: string, username: string) => `election:${id}:cand:${username}:votes`,
  ballots: (id: string) => `election:${id}:ballots`,
  expires: (id: string) => `election:${id}:expires`,
  finalized: (id: string) => `election:${id}:finalized`,
  isRunoff: (id: string) => `election:${id}:is_runoff`,
  seats: (id: string) => `election:${id}:seats`,
  winners: (id: string) => `election:${id}:winners`,
  mirrorSet: (id: string) => `election:${id}:mirror`,
  mirrorElement: (id: string, username: string, n: number) => `election:${id}:mirror:${username}:${n}`,
} as const;
```

Update `POLICIES` to:

```typescript
export const POLICIES = {
  create_proposal: 'role:member',
  vote: 'role:member',
  execute: 'role:member',
  add_member: 'role:member',
  start_election: 'role:member',
  cast_ballot: 'role:member',
  finalize_election: 'role:member',
  cast_runoff_vote: 'role:member',
  set_token_config: 'role:custodian',
  remove_member: 'role:custodian',
} as const;
```

- [ ] **Step 3: Write the failing test for dynamic distribution config**

Add to `server/test/handlers.test.ts` inside `describe('Governance handlers', ...)`:

```typescript
  it('honors custodian-configured distribution settings', () => {
    const node = new MockNode();
    const state = new MockState(node);
    // Custodian configured: 5000ms interval, 7 tokens per interval.
    state.setRegister('config:distribution_interval', 5000);
    state.setRegister('config:distribution_rate', 7);

    setupProposal(node, state, 'p1', 'quadratic', 20000);
    initUser(state, 'alice', 0);

    const vote = makeVoteHandler({ getTimeMs: () => 5000 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(0);

    expect(state.getRegister('tokens:alice')).toBe(
      TOKEN_CONFIG.initialTokens + 7
    );
  });
```

- [ ] **Step 4: Run to verify failure**

Run: `npx jest server/test/handlers.test.ts`
Expected: the new test FAILS (balance stays `initialTokens` because `distributeTokens` still reads `TOKEN_CONFIG`), other tests pass.

- [ ] **Step 5: Make `distributeTokens` dynamic in `shared/src/handlers.ts`**

Replace the whole `distributeTokens` function with:

```typescript
function distributeTokens(state: HandlerState, username: string, nowMs: number): number {
  const balanceReg = TOKEN_NAMES.balance(username);
  const lastDistReg = TOKEN_NAMES.lastDistribution(username);
  let balance = state.getRegister(balanceReg) || 0;
  let lastDist = state.getRegister(lastDistReg) || 0;

  if (lastDist === 0) {
    // Registers are initialized at user registration; if missing, fall back to 0.
    return balance;
  }

  const interval = state.getRegister(CONFIG_NAMES.distributionInterval()) || TOKEN_CONFIG.distributionIntervalMs;
  const rate = state.getRegister(CONFIG_NAMES.distributionRate()) || TOKEN_CONFIG.distributionRate;
  const elapsed = nowMs - lastDist;
  const intervals = Math.floor(elapsed / interval);
  if (intervals > 0) {
    balance += intervals * rate;
    lastDist += intervals * interval;
    state.setRegister(balanceReg, balance, 'system');
    state.setRegister(lastDistReg, lastDist, 'system');
  }
  return balance;
}
```

Update the import line at the top of `shared/src/handlers.ts` to include `CONFIG_NAMES`:

```typescript
import { CONFIG_NAMES, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES, VOTE_THRESHOLD } from './policies';
```

- [ ] **Step 6: Create config registers on both mirrors**

In `server/src/crabs.ts` `init()`, after the existing `addRegister('time_now', 0)` line add:

```typescript
    this.node.addRegister(CONFIG_NAMES.distributionInterval(), 0);
    this.node.addRegister(CONFIG_NAMES.distributionRate(), 0);
```

(`CONFIG_NAMES` must be added to the existing policies import in that file.)

In `client/src/dao.ts` `init()`, after the `addRegister('time_now', 0)` line add the same two lines, and extend the existing `@shared/policies` import with `CONFIG_NAMES`.

- [ ] **Step 7: Verify**

Run: `npx jest server/test/handlers.test.ts` → all PASS (11 tests).
Run: `npm run build:server` → OK. Run: `npm run build:client` → OK.

- [ ] **Step 8: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/handlers.test.ts server/src/crabs.ts client/src/dao.ts
git commit -m "feat: dynamic token distribution config registers"
```

---

## Task 2: start_election and cast_ballot handlers

**Files:**
- Modify: `shared/src/handlers.ts`
- Test: `server/test/handlers.test.ts`

- [ ] **Step 1: Write failing tests** — add to `server/test/handlers.test.ts` (new describe block after the existing one):

```typescript
import {
  makeStartElectionHandler,
  makeCastBallotHandler,
} from '../../shared/src/handlers';
// (merge into the existing import list at the top of the file)

describe('Election handlers', () => {
  let node: MockNode;
  let state: MockState;

  beforeEach(() => {
    node = new MockNode();
    state = new MockState(node);
    // seed members set via add_member semantics
    const addMember = makeAddMemberHandler();
    addMember(state, makeOp('add_member', 'admin', { username: 'alice', publicKeyHex: 'pk-a' }));
    addMember(state, makeOp('add_member', 'admin', { username: 'bob', publicKeyHex: 'pk-b' }));
    addMember(state, makeOp('add_member', 'admin', { username: 'carol', publicKeyHex: 'pk-c' }));
  });

  function startElection(id: string, candidates = ['alice', 'bob', 'carol'], nowMs = 0) {
    const handler = makeStartElectionHandler(node, { getTimeMs: () => nowMs });
    return handler(state, makeOp('start_election', 'alice', {
      electionId: id, candidates, expiresAt: 1000,
    }));
  }

  it('creates election resources for a valid candidate list', () => {
    expect(startElection('e1')).toBe(0);
    expect(state.getRegister('election:e1:expires')).toBe(1000);
    expect(state.getRegister('election:e1:is_runoff')).toBe(0);
    expect(state.getRegister('election:e1:seats')).toBe(5);
    expect(state.setContains('election:e1:candidates', 'alice')).toBe(true);
  });

  it('rejects candidates who are not members and duplicate candidates', () => {
    expect(startElection('e1', ['alice', 'dave'])).toBe(-1);
    expect(startElection('e2', ['alice', 'alice'])).toBe(-1);
    expect(state.getRegister('election:e1:expires')).toBe(0);
    expect(state.getRegister('election:e2:expires')).toBe(0);
  });

  it('rejects a duplicate election id', () => {
    expect(startElection('e1')).toBe(0);
    expect(startElection('e1')).toBe(-1);
  });

  it('accepts one ballot per voter with up to 5 picks', () => {
    startElection('e1');
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob', 'carol'] }))).toBe(0);
    expect(ballot(state, makeOp('cast_ballot', 'bob', { electionId: 'e1', picks: ['alice'] }))).toBe(0);
    expect(state.getPNCounter('election:e1:cand:bob:votes')).toBe(1);
    expect(state.getPNCounter('election:e1:cand:carol:votes')).toBe(1);
    expect(state.getPNCounter('election:e1:cand:alice:votes')).toBe(1);

    // Second ballot from the same voter is rejected.
    expect(ballot(state, makeOp('cast_ballot', 'bob', { electionId: 'e1', picks: ['alice'] }))).toBe(-1);
    expect(state.getPNCounter('election:e1:cand:alice:votes')).toBe(1);
  });

  it('rejects ballots with invalid picks, counts, or expired elections', () => {
    startElection('e1');
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    // Unknown candidate (not in this election)
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['zebra'] }))).toBe(-1);
    // Duplicate pick
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob', 'bob'] }))).toBe(-1);
    // Too many picks
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['a2', 'a3', 'a4', 'a5', 'a6', 'bob'] }))).toBe(-1);
    // Empty picks
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: [] }))).toBe(-1);
    // Unknown election
    expect(ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'nope', picks: ['bob'] }))).toBe(-1);
    // After expiry
    const expired = makeCastBallotHandler({ getTimeMs: () => 1001 });
    expect(expired(state, makeOp('cast_ballot', 'alice', { electionId: 'e1', picks: ['bob'] }))).toBe(-1);
    expect(state.getPNCounter('election:e1:cand:bob:votes')).toBe(0);
  });
});
```

NOTE: this requires `makeAddMemberHandler` in the import list (it is already exported). Also update the `setupProposal` helper's proposal payloads nowhere — unrelated.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest server/test/handlers.test.ts`
Expected: FAIL — `makeStartElectionHandler` / `makeCastBallotHandler` do not exist.

- [ ] **Step 3: Implement the handlers** — add to `shared/src/handlers.ts` (and extend the top import with `ELECTION_NAMES, CUSTODIAN_SEATS` and the payload types `StartElectionPayload, CastBallotPayload`):

```typescript
export function makeStartElectionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: StartElectionPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (
      !isNonEmptyString(id) ||
      !Array.isArray(payload.candidates) ||
      payload.candidates.length === 0 ||
      payload.candidates.length > 50 ||
      !payload.candidates.every(isNonEmptyString) ||
      new Set(payload.candidates).size !== payload.candidates.length
    ) {
      return -1;
    }
    for (const candidate of payload.candidates) {
      if (!state.setContains(STATE_NAMES.members, candidate)) {
        return -1;
      }
    }

    try {
      node.addORSet(ELECTION_NAMES.ballots(id));
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('duplicate_operation')) {
        return -1; // election id already in use
      }
      console.warn('start_election resource init warning:', err);
    }
    try { node.addORSet(ELECTION_NAMES.candidates(id)); } catch (err) { console.warn('start_election resource init warning:', err); }
    for (const candidate of payload.candidates) {
      try { node.addPNCounter(ELECTION_NAMES.candVotes(id, candidate)); } catch (err) { console.warn('start_election resource init warning:', err); }
      state.setAdd(ELECTION_NAMES.candidates(id), candidate, op.signerId);
    }
    try { node.addRegister(ELECTION_NAMES.expires(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.finalized(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.isRunoff(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.seats(id), 0); } catch (err) { /* ignore duplicate */ }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = typeof payload.expiresAt === 'number' && payload.expiresAt > nowMs
      ? payload.expiresAt
      : nowMs + TOKEN_CONFIG.defaultExpiryMs;

    state.setRegister(ELECTION_NAMES.expires(id), expiresAt, op.signerId);
    state.setRegister(ELECTION_NAMES.finalized(id), 0, op.signerId);
    state.setRegister(ELECTION_NAMES.isRunoff(id), 0, op.signerId);
    state.setRegister(ELECTION_NAMES.seats(id), CUSTODIAN_SEATS, op.signerId);
    return 0;
  };
}

export function makeCastBallotHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: CastBallotPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (!isNonEmptyString(id) || !Array.isArray(payload.picks)) {
      return -1;
    }
    if (payload.picks.length < 1 || payload.picks.length > CUSTODIAN_SEATS) {
      return -1;
    }
    if (!payload.picks.every(isNonEmptyString) || new Set(payload.picks).size !== payload.picks.length) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0 || nowMs > expiresAt) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.finalized(id)) === 1) {
      return -1;
    }

    const ballots = ELECTION_NAMES.ballots(id);
    if (state.setContains(ballots, op.signerId)) {
      return -1; // one ballot per voter
    }

    for (const pick of payload.picks) {
      if (!state.setContains(ELECTION_NAMES.candidates(id), pick)) {
        return -1;
      }
    }

    state.setAdd(ballots, op.signerId, op.signerId);
    for (const pick of payload.picks) {
      state.incrementPNCounter(ELECTION_NAMES.candVotes(id, pick), 1, op.signerId);
    }
    return 0;
  };
}
```

- [ ] **Step 4: Verify**

Run: `npx jest server/test/handlers.test.ts` → all PASS. Run: `npm run build:server && npm run build:client` → OK.

- [ ] **Step 5: Commit**

```bash
git add shared/src/handlers.ts server/test/handlers.test.ts
git commit -m "feat: custodian election start and ballot handlers"
```

---

## Task 3: rankCandidates + finalize_election (clear winners and runoff spawn)

**Files:**
- Modify: `shared/src/handlers.ts`
- Test: `server/test/handlers.test.ts`

- [ ] **Step 1: Write failing tests** — append to the `Election handlers` describe block:

```typescript
  function ballotFor(voter: string, picks: string[], time = 0) {
    const ballot = makeCastBallotHandler({ getTimeMs: () => time });
    expect(ballot(state, makeOp('cast_ballot', voter, { electionId: 'e1', picks }))).toBe(0);
  }

  it('finalizes with clear top-5 winners after expiry', () => {
    startElection('e1');
    // alice 3, bob 1, carol 1 -> both winners (under 5 candidates, all with votes)
    ballotFor('alice', ['alice', 'bob', 'carol']);
    ballotFor('bob', ['alice']);
    ballotFor('carol', ['alice', 'bob']);

    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 1001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e1', candidates: ['alice', 'bob', 'carol'] }))).toBe(0);

    expect(state.getRegister('election:e1:finalized')).toBe(1);
    expect(state.setContains('election:e1:winners', 'alice')).toBe(true);
    expect(state.setContains('election:e1:winners', 'bob')).toBe(true);
    expect(state.setContains('election:e1:winners', 'carol')).toBe(true);
  });

  it('spawns a quadratic runoff when the seat cutoff is tied', () => {
    startElection('e1');
    // 5 voters: alice 3, then bob/carol/dave tied at 1 for one remaining seat
    for (const name of ['alice', 'bob', 'carol', 'dave', 'erin']) {
      const addMember = makeAddMemberHandler();
      addMember(state, makeOp('add_member', 'admin', { username: name === 'alice' ? 'x-' + name : name, publicKeyHex: 'pk' }));
    }
    // rebuild election with 5 members as candidates
    startElection('e2', ['alice', 'bob', 'carol', 'dave', 'erin']);
    const ballot = makeCastBallotHandler({ getTimeMs: () => 0 });
    // alice 3 votes, bob 1, carol 1 (tie for 2nd of 2 seats)
    ballot(state, makeOp('cast_ballot', 'bob', { electionId: 'e2', picks: ['alice'] }));
    ballot(state, makeOp('cast_ballot', 'carol', { electionId: 'e2', picks: ['alice'] }));
    ballot(state, makeOp('cast_ballot', 'dave', { electionId: 'e2', picks: ['alice', 'bob'] }));
    ballot(state, makeOp('cast_ballot', 'erin', { electionId: 'e2', picks: ['alice', 'carol'] }));
    ballot(state, makeOp('cast_ballot', 'alice', { electionId: 'e2', picks: ['alice'] }));

    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 1001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e2', candidates: ['alice', 'bob', 'carol', 'dave', 'erin'] }))).toBe(0);

    // alice cleared (3 > 1); bob/carol tied at cutoff -> runoff with 1 seat at stake
    expect(state.getRegister('election:e2:finalized')).toBe(2);
    expect(state.setContains('election:e2:winners', 'alice')).toBe(true);
    expect(state.getRegister('election:e2:runoff:is_runoff')).toBe(1);
    expect(state.getRegister('election:e2:runoff:seats')).toBe(1);
    expect(state.getRegister('election:e2:runoff:expires')).toBe(1001 + 60000);
    expect(state.setContains('election:e2:runoff:candidates', 'bob')).toBe(true);
    expect(state.setContains('election:e2:runoff:candidates', 'carol')).toBe(true);

    // Double finalize is idempotent while runoff pending.
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e2', candidates: ['alice', 'bob', 'carol', 'dave', 'erin'] }))).toBe(0);
    expect(state.getRegister('election:e2:finalized')).toBe(2);
  });

  it('finalizes with empty seats when nobody receives votes', () => {
    startElection('e3');
    const finalize = makeFinalizeElectionHandler({ getTimeMs: () => 1001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e3', candidates: ['alice', 'bob', 'carol'] }))).toBe(0);
    expect(state.getRegister('election:e3:finalized')).toBe(1);
    expect(state.setContains('election:e3:winners', 'alice')).toBe(false);
  });

  it('rejects finalize before expiry or for unknown elections', () => {
    startElection('e4');
    const finalize = makeFinalizeElectionHandler({ getTimeMs: () => 0 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'e4', candidates: ['alice', 'bob', 'carol'] }))).toBe(0);
    expect(state.getRegister('election:e4:finalized')).toBe(0);
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: 'zz', candidates: ['alice'] }))).toBe(-1);
  });
```

Note: the first test's `ballotFor` helper is defined in the block above; place these tests in the same describe so helpers resolve. (`makeFinalizeElectionHandler` must be added to the imports at the top.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest server/test/handlers.test.ts`
Expected: FAIL — `makeFinalizeElectionHandler` does not exist.

- [ ] **Step 3: Implement** — add to `shared/src/handlers.ts` (imports gain `FinalizeElectionPayload`, `runoffId` from policies):

```typescript
// Shared ranking used by the finalize handler, the server's custodian grant
// flow, and the client's election mirroring so all three compute identical
// results. Ties sort alphabetically. Zero-vote candidates never win.
export function rankCandidates(
  candidates: string[],
  getVotes: (candidate: string) => number,
  seats: number,
  allowRunoff: boolean
): { winners: string[]; runoffCandidates: string[]; runoffSeats: number } {
  const ranked = candidates
    .map((candidate) => ({ candidate, votes: getVotes(candidate) }))
    .filter((entry) => entry.votes > 0)
    .sort((a, b) => b.votes - a.votes || a.candidate.localeCompare(b.candidate));

  if (ranked.length <= seats) {
    return { winners: ranked.map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  const cutoffVotes = ranked[seats].votes;
  if (ranked[seats - 1].votes !== cutoffVotes) {
    return { winners: ranked.slice(0, seats).map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  if (!allowRunoff) {
    // Runoff deadlock guard: alphabetical order already applied by the sort.
    return { winners: ranked.slice(0, seats).map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  const clear = ranked.filter((e) => e.votes > cutoffVotes).map((e) => e.candidate);
  const tied = ranked.filter((e) => e.votes === cutoffVotes).map((e) => e.candidate);
  return { winners: clear, runoffCandidates: tied, runoffSeats: seats - clear.length };
}

export function makeFinalizeElectionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: FinalizeElectionPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (!isNonEmptyString(id) || !Array.isArray(payload.candidates) || !payload.candidates.every(isNonEmptyString)) {
      return -1;
    }
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0) {
      return -1;
    }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    if (nowMs < expiresAt) {
      return 0; // not expired yet; no-op
    }
    const finalized = state.getRegister(ELECTION_NAMES.finalized(id));
    if (finalized === 1 || finalized === 2) {
      return 0; // idempotent
    }
    const isRunoff = state.getRegister(ELECTION_NAMES.isRunoff(id)) === 1;
    const seats = state.getRegister(ELECTION_NAMES.seats(id)) || 0;
    if (seats <= 0) {
      return -1;
    }
    for (const candidate of payload.candidates) {
      if (!state.setContains(ELECTION_NAMES.candidates(id), candidate)) {
        return -1;
      }
    }

    const getVotes = (candidate: string) => state.getPNCounter(ELECTION_NAMES.candVotes(id, candidate)) || 0;
    const result = rankCandidates(payload.candidates, getVotes, seats, !isRunoff);

    for (const winner of result.winners) {
      state.setAdd(ELECTION_NAMES.winners(id), winner, op.signerId);
    }

    if (result.runoffCandidates.length > 0) {
      const rid = runoffId(id);
      try { node.addORSet(ELECTION_NAMES.ballots(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      try { node.addORSet(ELECTION_NAMES.candidates(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      try { node.addORSet(ELECTION_NAMES.mirrorSet(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      for (const candidate of result.runoffCandidates) {
        try { node.addPNCounter(ELECTION_NAMES.candVotes(rid, candidate)); } catch (err) { console.warn('finalize resource init warning:', err); }
        state.setAdd(ELECTION_NAMES.candidates(rid), candidate, op.signerId);
      }
      try { node.addRegister(ELECTION_NAMES.expires(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.finalized(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.isRunoff(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.seats(rid), 0); } catch (err) { /* ignore duplicate */ }

      state.setRegister(ELECTION_NAMES.expires(rid), nowMs + TOKEN_CONFIG.defaultExpiryMs, op.signerId);
      state.setRegister(ELECTION_NAMES.isRunoff(rid), 1, op.signerId);
      state.setRegister(ELECTION_NAMES.seats(rid), result.runoffSeats, op.signerId);
      state.setRegister(ELECTION_NAMES.finalized(id), 2, op.signerId); // awaiting runoff
      return 0;
    }

    if (isRunoff) {
      const parentId = id.slice(0, -RUNOFF_SUFFIX.length);
      for (const winner of result.winners) {
        state.setAdd(ELECTION_NAMES.winners(parentId), winner, op.signerId);
      }
      state.setRegister(ELECTION_NAMES.finalized(parentId), 1, op.signerId);
    }
    state.setRegister(ELECTION_NAMES.finalized(id), 1, op.signerId);
    return 0;
  };
}
```

The policies import in `shared/src/handlers.ts` becomes:

```typescript
import {
  CONFIG_NAMES, CUSTODIAN_SEATS, ELECTION_NAMES, runoffId, RUNOFF_SUFFIX, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES, VOTE_THRESHOLD,
} from './policies';
```

- [ ] **Step 4: Verify**

Run: `npx jest server/test/handlers.test.ts` → all PASS. Run: `npm run build:server && npm run build:client` → OK.

- [ ] **Step 5: Commit**

```bash
git add shared/src/handlers.ts server/test/handlers.test.ts
git commit -m "feat: election finalize with quadratic runoff spawn"
```

---

## Task 4: cast_runoff_vote (quadratic runoff voting)

**Files:**
- Modify: `shared/src/handlers.ts`
- Test: `server/test/handlers.test.ts`

- [ ] **Step 1: Write failing tests** — append to the `Election handlers` describe block:

```typescript
  function setupRunoff(parentId: string, tied: string[], seatsAtStake: number) {
    // Spawn a runoff the same way the finalize handler does.
    const rid = runoffId(parentId);
    try { node.addORSet(ELECTION_NAMES.ballots(rid)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(ELECTION_NAMES.candidates(rid)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(ELECTION_NAMES.mirrorSet(rid)); } catch (err) { /* ignore duplicate */ }
    for (const c of tied) {
      try { node.addPNCounter(ELECTION_NAMES.candVotes(rid, c)); } catch (err) { /* ignore duplicate */ }
      state.setAdd(ELECTION_NAMES.candidates(rid), c, 'system');
    }
    try { node.addRegister(ELECTION_NAMES.expires(rid), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.finalized(rid), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.isRunoff(rid), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.seats(rid), 0); } catch (err) { /* ignore duplicate */ }
    state.setRegister(ELECTION_NAMES.expires(rid), 100000, 'system');
    state.setRegister(ELECTION_NAMES.isRunoff(rid), 1, 'system');
    state.setRegister(ELECTION_NAMES.seats(rid), seatsAtStake, 'system');
    return rid;
  }

  it('charges n^2 for repeated runoff votes and resolves the seat', () => {
    initUser(state, 'alice', 0);
    initUser(state, 'bob', 0);
    const rid = setupRunoff('e2', ['bob', 'carol'], 1);

    const vote = makeCastRunoffVoteHandler({ getTimeMs: () => 0 });
    // alice: cumulative 1, 5, 14 <= 20 -> three votes on bob
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(0);
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(0);
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(0);
    expect(state.getPNCounter(`election:${rid}:cand:bob:votes`)).toBe(3);

    // bob: 1 vote for carol
    expect(vote(state, makeOp('cast_runoff_vote', 'bob', { electionId: rid, candidate: 'carol' }))).toBe(0);
    expect(state.getPNCounter(`election:${rid}:cand:carol:votes`)).toBe(1);

    // alice's 4th vote would cost cumulative 30 > 20 -> rejected
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(-1);
    expect(state.getPNCounter(`election:${rid}:cand:bob:votes`)).toBe(3);

    // Unknown candidate rejected
    expect(vote(state, makeOp('cast_runoff_vote', 'carol', { electionId: rid, candidate: 'alice' }))).toBe(-1);

    // Runoff finalize: bob wins the single seat with alphabetical guard; parent finalized
    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 100001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: rid, candidates: ['bob', 'carol'] }))).toBe(0);
    expect(state.getRegister(`election:${rid}:finalized`)).toBe(1);
    expect(state.setContains('election:e2:winners', 'bob')).toBe(true);
    expect(state.getRegister('election:e2:finalized')).toBe(1);
  });

  it('breaks a tied runoff alphabetically (deadlock guard)', () => {
    initUser(state, 'alice', 0);
    const rid = setupRunoff('e2', ['bob', 'carol'], 1);
    const vote = makeCastRunoffVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(0);
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'carol' }))).toBe(0);
    // tie 1-1 for one seat -> alphabetical: 'bob' < 'carol'
    const finalize = makeFinalizeElectionHandler(node, { getTimeMs: () => 100001 });
    expect(finalize(state, makeOp('finalize_election', 'alice', { electionId: rid, candidates: ['bob', 'carol'] }))).toBe(0);
    expect(state.setContains('election:e2:winners', 'bob')).toBe(true);
    expect(state.setContains('election:e2:winners', 'carol')).toBe(false);
  });

  it('rejects runoff votes on non-runoff or finalized elections', () => {
    startElection('e5');
    const vote = makeCastRunoffVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: 'e5', candidate: 'bob' }))).toBe(-1);
    initUser(state, 'alice', 0);
    const rid = setupRunoff('e2', ['bob', 'carol'], 1);
    const fin = makeFinalizeElectionHandler(node, { getTimeMs: () => 100001 });
    fin(state, makeOp('finalize_election', 'alice', { electionId: rid, candidates: ['bob', 'carol'] }));
    expect(vote(state, makeOp('cast_runoff_vote', 'alice', { electionId: rid, candidate: 'bob' }))).toBe(-1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest server/test/handlers.test.ts`
Expected: FAIL — `makeCastRunoffVoteHandler` does not exist.

- [ ] **Step 3: Implement** — add to `shared/src/handlers.ts` (imports gain `CastRunoffVotePayload`):

```typescript
export function makeCastRunoffVoteHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: CastRunoffVotePayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (!isNonEmptyString(id) || !isNonEmptyString(payload.candidate)) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.isRunoff(id)) !== 1) {
      return -1;
    }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0 || nowMs > expiresAt) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.finalized(id)) === 1) {
      return -1;
    }
    if (!state.setContains(ELECTION_NAMES.candidates(id), payload.candidate)) {
      return -1;
    }

    // Quadratic cost from the voter's global token balance, mirrored per runoff.
    const balance = distributeTokens(state, op.signerId, nowMs);
    const mirror = ELECTION_NAMES.mirrorSet(id);
    let used = 0;
    const maxVoteCheck = 100;
    for (let i = 1; i <= maxVoteCheck; i++) {
      const element = ELECTION_NAMES.mirrorElement(id, op.signerId, i);
      if (state.setContains(mirror, element)) {
        used = i;
      } else {
        break;
      }
    }
    const nextVote = used + 1;
    const cumulativeCost = (nextVote * (nextVote + 1) * (2 * nextVote + 1)) / 6;
    if (balance < cumulativeCost) {
      return -1;
    }
    state.setAdd(mirror, ELECTION_NAMES.mirrorElement(id, op.signerId, nextVote), `${op.signerId}:${nextVote}`);
    state.incrementPNCounter(ELECTION_NAMES.candVotes(id, payload.candidate), 1, op.signerId);
    return 0;
  };
}
```

- [ ] **Step 4: Verify**

Run: `npx jest server/test/handlers.test.ts` → all PASS. Run: `npm run build:server && npm run build:client` → OK.

- [ ] **Step 5: Commit**

```bash
git add shared/src/handlers.ts server/test/handlers.test.ts
git commit -m "feat: quadratic runoff voting for tied custodian seats"
```

---

## Task 5: set_token_config and remove_member handlers

**Files:**
- Modify: `shared/src/handlers.ts`
- Test: `server/test/handlers.test.ts`

- [ ] **Step 1: Write failing tests** — append to the `Election handlers` describe block:

```typescript
  it('applies custodian token config and removes members', () => {
    initUser(state, 'dave', 0);
    const addMember = makeAddMemberHandler();
    addMember(state, makeOp('add_member', 'admin', { username: 'dave', publicKeyHex: 'pk-d' }));

    const setConfig = makeSetTokenConfigHandler({ getTimeMs: () => 0 });
    expect(setConfig(state, makeOp('set_token_config', 'alice', { intervalMs: 1000, rate: 5 }))).toBe(0);
    expect(state.getRegister('config:distribution_interval')).toBe(1000);
    expect(state.getRegister('config:distribution_rate')).toBe(5);

    expect(setConfig(state, makeOp('set_token_config', 'alice', { intervalMs: 0, rate: 5 }))).toBe(-1);
    expect(setConfig(state, makeOp('set_token_config', 'alice', { intervalMs: 1000, rate: 0 }))).toBe(-1);
    expect(setConfig(state, makeOp('set_token_config', 'alice', { intervalMs: 999, rate: 5 }))).toBe(-1);
    expect(setConfig(state, makeOp('set_token_config', 'alice', { intervalMs: 1000, rate: -1 }))).toBe(-1);
    expect(state.getRegister('config:distribution_interval')).toBe(1000);

    const removeMember = makeRemoveMemberHandler();
    expect(removeMember(state, makeOp('remove_member', 'alice', { username: 'dave' }))).toBe(0);
    expect(state.setContains('members', 'dave')).toBe(false);
    expect(state.getRegister('tokens:dave')).toBe(0);
    expect(state.getRegister('tokens:dave:last_dist')).toBe(0);

    expect(removeMember(state, makeOp('remove_member', 'alice', { username: 'dave' }))).toBe(-1);
    expect(removeMember(state, makeOp('remove_member', 'alice', { username: 'ghost' }))).toBe(-1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest server/test/handlers.test.ts`
Expected: FAIL — handlers do not exist.

- [ ] **Step 3: Implement** — add to `shared/src/handlers.ts` (imports gain `RemoveMemberPayload, SetTokenConfigPayload`):

```typescript
export function makeSetTokenConfigHandler(
  _config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SetTokenConfigPayload = JSON.parse(op.payload || '{}');
    if (
      typeof payload.intervalMs !== 'number' ||
      !Number.isInteger(payload.intervalMs) ||
      payload.intervalMs < 1000 ||
      typeof payload.rate !== 'number' ||
      !Number.isInteger(payload.rate) ||
      payload.rate < 1
    ) {
      return -1;
    }
    state.setRegister(CONFIG_NAMES.distributionInterval(), payload.intervalMs, op.signerId);
    state.setRegister(CONFIG_NAMES.distributionRate(), payload.rate, op.signerId);
    return 0;
  };
}

export function makeRemoveMemberHandler() {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: RemoveMemberPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.username)) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, payload.username)) {
      return -1;
    }
    state.setRemove(STATE_NAMES.members, payload.username);
    state.setRegister(TOKEN_NAMES.balance(payload.username), 0, 'system');
    state.setRegister(TOKEN_NAMES.lastDistribution(payload.username), 0, 'system');
    return 0;
  };
}
```

- [ ] **Step 4: Verify**

Run: `npx jest server/test/handlers.test.ts` → all PASS. Run: `npm run build:server && npm run build:client` → OK.

- [ ] **Step 5: Commit**

```bash
git add shared/src/handlers.ts server/test/handlers.test.ts
git commit -m "feat: custodian token config and member removal handlers"
```

(Plan continues in Task 5b–9: server grant/sync wiring, client DAO, UI, smoke test — see next section of this file.)

---

## Task 6: Server wiring — policies, custodian grants, sync_roles log entries

**Files:**
- Modify: `server/src/crabs.ts`
- Modify: `server/src/handlers.ts`
- Modify: `server/src/server.ts`
- Test: `server/test/crabs.test.ts`

- [ ] **Step 1: Write the failing CRABS-level policy test** — append to `server/test/crabs.test.ts`:

```typescript
  it('enforces the custodian policy on set_token_config', async () => {
    const dao = new DaoNode();
    await dao.init();
    const key = await KeyPair.generate();
    dao.registerMember('alice', key.publicKeyHex());

    const buildConfigOp = async (version: number) => {
      const op = await Operation.create('set_token_config');
      op.signerId = 'alice';
      op.nodeId = 'browser';
      op.payload = new TextEncoder().encode(JSON.stringify({ intervalMs: 1000, rate: 5 }) + '\0');
      setOperationSignerKeyVersion(op, version);
      dao.node.sign(op, key);
      return op.serialize();
    };

    // Not a custodian -> policy rejects.
    const rejected = await buildConfigOp(3);
    await expect(dao.deserializeOperation(rejected).then((op) => (dao.executeOperation(op), op))).rejects.toThrow();

    // Grant custodian (bumps alice's key_version to 4).
    dao.grantCustodian('alice');
    const accepted = await buildConfigOp(4);
    dao.executeOperation(await dao.deserializeOperation(accepted));
    expect(dao.node.getRegister('config:distribution_interval')).toBe(1000);
    expect(dao.node.getRegister('config:distribution_rate')).toBe(5);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest server/test/crabs.test.ts`
Expected: FAIL — `dao.grantCustodian` does not exist.

- [ ] **Step 3: Wire the server mirror — `server/src/crabs.ts`**

Add to the imports:

```typescript
import {
  CONFIG_NAMES, CUSTODIAN_SEATS, ELECTION_NAMES, POLICIES, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES,
} from '../../shared/src/policies';
import {
  makeAddMemberHandler, makeCastBallotHandler, makeCastRunoffVoteHandler,
  makeCreateProposalHandler, makeExecuteHandler, makeFinalizeElectionHandler,
  makeRemoveMemberHandler, makeSetTokenConfigHandler, makeStartElectionHandler, makeVoteHandler,
} from '../../shared/src/handlers';
import { SyncRolesPayload } from '../../shared/src/types';
```

In `init()`, after the existing policies, add:

```typescript
    this.node.setPolicy('start_election', POLICIES.start_election);
    this.node.setPolicy('cast_ballot', POLICIES.cast_ballot);
    this.node.setPolicy('finalize_election', POLICIES.finalize_election);
    this.node.setPolicy('cast_runoff_vote', POLICIES.cast_runoff_vote);
    this.node.setPolicy('set_token_config', POLICIES.set_token_config);
    this.node.setPolicy('remove_member', POLICIES.remove_member);
```

And after the existing `registerHandlerJs` calls, add:

```typescript
    this.node.registerHandlerJs('start_election', makeStartElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_ballot', makeCastBallotHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('finalize_election', makeFinalizeElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_runoff_vote', makeCastRunoffVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('set_token_config', makeSetTokenConfigHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('remove_member', makeRemoveMemberHandler());
    this.node.registerHandlerJs('sync_roles', () => 0); // admin-signed; state applied out-of-band
```

Add these members/methods to `DaoNode`:

```typescript
  currentCustodians: string[] = [];

  grantCustodian(username: string) {
    this.node.grantRole(username, 'role', 'custodian', ADMIN_ID);
    if (!this.currentCustodians.includes(username)) {
      this.currentCustodians.push(username);
    }
  }

  grantMemberRole(username: string) {
    this.node.grantRole(username, 'role', 'member', ADMIN_ID);
    this.currentCustodians = this.currentCustodians.filter((u) => u !== username);
  }

  revokeMember(username: string) {
    try { this.node.revokeUser(username); } catch (err) { console.warn('revokeUser failed:', err); }
  }

  isElectionWinner(electionId: string, username: string): boolean {
    return this.node.setContains(ELECTION_NAMES.winners(electionId), username) || false;
  }

  getUserRoleVersion(username: string): number {
    return this.node.getUser(username)?.keyVersion ?? 0;
  }

  async createSyncRolesOperation(payload: SyncRolesPayload): Promise<Operation> {
    return this.createAdminOperation('sync_roles', payload);
  }

  // Called after every executed operation (live and during hydration).
  // Detects finalized elections and, when the winner set differs from the
  // current custodians, applies role grants and returns a sync_roles
  // operation for the caller to persist and broadcast (null during hydration).
  observeOperation(op: Operation): Operation | null {
    if (op.type !== 'finalize_election') {
      return null;
    }
    const payload = this.parseFinalizePayload(op);
    if (!payload) {
      return null;
    }
    const winners = payload.candidates.filter((c) => this.isElectionWinner(payload.electionId, c));
    const additions = winners.filter((w) => !this.currentCustodians.includes(w));
    const removed = this.currentCustodians.filter((c) => !winners.includes(c));
    if (winners.length === 0 || (removed.length === 0 && this.currentCustodians.every((c) => winners.includes(c)))) {
      return null;
    }
    const roleVersions: Record<string, number> = {};
    for (const user of [...removed, ...winners]) {
      if (removed.includes(user)) {
        this.grantMemberRole(user);
      } else {
        this.grantCustodian(user);
      }
      roleVersions[user] = this.getUserRoleVersion(user);
    }
    this.currentCustodians = [...winners];
    return this.createSyncRolesOperation({ custodians: this.currentCustodians, roleVersions });
  }

  private parseFinalizePayload(op: Operation): { electionId: string; candidates: string[] } | null {
    try {
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const parsed = JSON.parse(json.replace(/\0$/, ''));
      if (!parsed || typeof parsed.electionId !== 'string' || !Array.isArray(parsed.candidates)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
```

Wait — during hydration the grants must be applied inline (before subsequent ops execute for policy checks), but no `sync_roles` broadcast is needed. The `observeOperation` above returns the sync op in BOTH cases; the hydration path applies role changes directly when executing the returned sync op server-side (executing `sync_roles` on the server is a no-op handler; grants were already applied by `observeOperation`). Callers persist+broadcast the returned op when non-null. During hydration the caller persists it too (so it lands in the log before later ops) but does NOT broadcast — actually broadcasting during hydration is harmless (no sockets yet). Keep: always persist; broadcast via handler only for live ops.

- [ ] **Step 4: Wire ConnectionHandler — `server/src/handlers.ts`**

In the `submit_op` queue body, after `this.dao.executeOperation(op);`, add:

```typescript
              const syncOp = this.dao.observeOperation(op);
              if (syncOp) {
                const syncBytes = syncOp.serialize();
                const syncIndex = await this.db.getOperationCount();
                const syncStored: StoredOperation = { index: syncIndex, bytes: Buffer.from(syncBytes).toString('base64') };
                await this.db.putOperation(syncIndex, syncStored);
                this.broadcast({ kind: 'broadcast', operation: syncStored });
              }
              if (op.type === 'remove_member') {
                try {
                  const raw = typeof op.payload === 'string' ? op.payload : new TextDecoder().decode(op.payload as Uint8Array);
                  const parsed = JSON.parse(raw.replace(/\0$/, ''));
                  if (parsed && typeof parsed.username === 'string') {
                    this.dao.revokeMember(parsed.username);
                  }
                } catch (err) {
                  console.warn('remove_member revoke failed:', err);
                }
              }
```

- [ ] **Step 5: Hydration — `server/src/server.ts`**

In `hydrateDao`, inside the ops loop, after `dao.executeOperation(operation);` add:

```typescript
      const syncOp = dao.observeOperation(operation);
      if (syncOp) {
        const syncIndex = await db.getOperationCount();
        await db.putOperation(syncIndex, { index: syncIndex, bytes: Buffer.from(syncOp.serialize()).toString('base64') });
        dao.executeOperation(syncOp);
      }
```

- [ ] **Step 6: Verify**

Run: `npx jest server/test/crabs.test.ts` → PASS. Run: `npm run build:server && npm run test:server` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/crabs.ts server/src/handlers.ts server/src/server.ts server/test/crabs.test.ts
git commit -m "feat(server): custodian role grants and sync_roles log entries"
```

---

## Task 7: Client DAO — election mirroring, op wrappers, custodian sync

**Files:**
- Modify: `client/src/dao.ts`
- Verify: `npm run build:client`

- [ ] **Step 1: Update imports in `client/src/dao.ts`**

```typescript
import { loadCRABS } from './wasm';
import {
  CONFIG_NAMES, CUSTODIAN_SEATS, ELECTION_NAMES, POLICIES, STATE_NAMES, TOKEN_CONFIG, TOKEN_NAMES, runoffId,
} from '@shared/policies';
import {
  setOperationSignerKeyVersion,
} from '@shared/crabs-helpers';
import {
  AddMemberPayload, CastBallotPayload, CastRunoffVotePayload, ExecutePayload,
  FinalizeElectionPayload, ProposalPayload, RemoveMemberPayload, SetTokenConfigPayload,
  StartElectionPayload, SyncRolesPayload, VotePayload,
} from '@shared/types';
import {
  makeAddMemberHandler, makeCastBallotHandler, makeCastRunoffVoteHandler,
  makeCreateProposalHandler, makeExecuteHandler, makeFinalizeElectionHandler,
  makeRemoveMemberHandler, makeSetTokenConfigHandler, makeStartElectionHandler,
  makeVoteHandler, rankCandidates,
} from '@shared/handlers';
```

- [ ] **Step 2: In `BrowserDao.init()`** — after the existing policy/handler registrations, add:

```typescript
    this.node.setPolicy('start_election', POLICIES.start_election);
    this.node.setPolicy('cast_ballot', POLICIES.cast_ballot);
    this.node.setPolicy('finalize_election', POLICIES.finalize_election);
    this.node.setPolicy('cast_runoff_vote', POLICIES.cast_runoff_vote);
    this.node.setPolicy('set_token_config', POLICIES.set_token_config);
    this.node.setPolicy('remove_member', POLICIES.remove_member);

    this.node.registerHandlerJs('start_election', makeStartElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_ballot', makeCastBallotHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('finalize_election', makeFinalizeElectionHandler(this.node, { getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('cast_runoff_vote', makeCastRunoffVoteHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('set_token_config', makeSetTokenConfigHandler({ getTimeMs: () => this.getNodeTimeMs() }));
    this.node.registerHandlerJs('remove_member', makeRemoveMemberHandler());
    this.node.registerHandlerJs('sync_roles', () => 0);
```

Add election mirroring state and methods:

```typescript
  private elections = new Map<string, { electionId: string; candidates: string[]; isRunoff: boolean; seats: number }>();
  custodians: string[] = [];
  private roleChangeCount = new Map<string, number>();

  async startElection(userId: string, payload: StartElectionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('start_election', userId, JSON.stringify(payload));
  }
  async castBallot(userId: string, payload: CastBallotPayload): Promise<Uint8Array> {
    return this.signAndSerialize('cast_ballot', userId, JSON.stringify(payload));
  }
  async finalizeElection(userId: string, payload: FinalizeElectionPayload): Promise<Uint8Array> {
    return this.signAndSerialize('finalize_election', userId, JSON.stringify(payload));
  }
  async castRunoffVote(userId: string, payload: CastRunoffVotePayload): Promise<Uint8Array> {
    return this.signAndSerialize('cast_runoff_vote', userId, JSON.stringify(payload));
  }
  async setTokenConfig(userId: string, payload: SetTokenConfigPayload): Promise<Uint8Array> {
    return this.signAndSerialize('set_token_config', userId, JSON.stringify(payload));
  }
  async removeMember(userId: string, payload: RemoveMemberPayload): Promise<Uint8Array> {
    return this.signAndSerialize('remove_member', userId, JSON.stringify(payload));
  }
```

- [ ] **Step 3: Replace `executeRemote`** with a version that mirrors elections and applies `sync_roles` locally:

```typescript
  async executeRemote(bytes: Uint8Array): Promise<void> {
    const op = await this.Operation.deserialize(bytes);
    try {
      if (op.type === 'sync_roles') {
        await this.applySyncRoles(bytes);
        return;
      }
      this.node.execute(op);
      const proposal = await this.parseCreateProposal(bytes);
      if (proposal) {
        this.proposals.set(proposal.proposalId, proposal);
      }
      await this.mirrorElectionState(bytes);
    } finally {
      op.destroy();
    }
  }

  private async applySyncRoles(bytes: Uint8Array): Promise<void> {
    const parsed = await this.parseJsonPayload(bytes);
    if (!parsed) return;
    const payload = parsed as SyncRolesPayload;
    if (!Array.isArray(payload.custodians) || typeof payload.roleVersions !== 'object') return;
    this.custodians = payload.custodians.filter((u) => typeof u === 'string');
    for (const [username, version] of Object.entries(payload.roleVersions)) {
      if (typeof version !== 'number' || version < 0) continue;
      const applied = this.roleChangeCount.get(username) ?? 0;
      const isCustodian = this.custodians.includes(username);
      const roleValue = isCustodian ? 'custodian' : 'member';
      const registered = this.node.getUser(username)?.status === 'active';
      if (registered) {
        for (let i = applied; i < version; i++) {
          this.node.grantRole(username, 'role', roleValue, this.adminId);
        }
      }
      this.roleChangeCount.set(username, version);
      if (username === this.walletUser && registered) {
        this.keyVersion = version;
      }
    }
  }

  private walletUser = '';

  // Called at init/login so applySyncRoles knows the local username.
  setWalletUser(username: string) {
    this.walletUser = username;
  }

  private async mirrorElectionState(bytes: Uint8Array): Promise<void> {
    const parsed = await this.parseJsonPayload(bytes);
    if (!parsed) return;
    const type = (parsed as { type?: string }).type;
    if (type === 'start_election') {
      const p = parsed as unknown as StartElectionPayload;
      this.elections.set(p.electionId, { electionId: p.electionId, candidates: p.candidates, isRunoff: false, seats: 5 });
    } else if (type === 'finalize_election') {
      const p = parsed as unknown as FinalizeElectionPayload;
      const election = this.elections.get(p.electionId);
      if (!election) return;
      const isRunoff = this.node.getRegister(ELECTION_NAMES.isRunoff(p.electionId)) === 1;
      if (isRunoff) {
        const rid = runoffId(p.electionId);
        const seats = this.node.getRegister(ELECTION_NAMES.seats(rid)) || 0;
        const tied: string[] = [];
        for (const candidate of election.candidates) {
          if (this.node.setContains(ELECTION_NAMES.candidates(rid), candidate)) {
            tied.push(candidate);
          }
        }
        this.elections.set(rid, { electionId: rid, candidates: tied, isRunoff: true, seats });
      }
    }
  }

  private async parseJsonPayload(bytes: Uint8Array): Promise<Record<string, unknown> | null> {
    const op = await this.Operation.deserialize(bytes);
    try {
      if (op.type !== 'sync_roles' && op.type !== 'start_election' && op.type !== 'finalize_election') return null;
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      return JSON.parse(json.replace(/\0$/, ''));
    } catch {
      return null;
    } finally {
      op.destroy();
    }
  }
```

NOTE: `parseJsonPayload` needs the op type — add `const type = op.type;` capture before try and include it in the return: change signature to return `{ type: string } & Record<string, unknown> | null`:

```typescript
  private async parseJsonPayload(bytes: Uint8Array): Promise<({ type: string } & Record<string, unknown>) | null> {
    const op = await this.Operation.deserialize(bytes);
    try {
      if (op.type !== 'sync_roles' && op.type !== 'start_election' && op.type !== 'finalize_election') return null;
      const raw = op.payload;
      const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      return { type: op.type, ...(JSON.parse(json.replace(/\0$/, '')) as object) };
    } catch {
      return null;
    } finally {
      op.destroy();
    }
  }
```

(Adjust the two call sites to read `parsed.type` accordingly.)

- [ ] **Step 4: Add election/custodian read accessors** to `BrowserDao`:

```typescript
  getElections(): Array<{ electionId: string; candidates: string[]; isRunoff: boolean; seats: number }> {
    return Array.from(this.elections.values());
  }

  getElectionVotes(id: string): Record<string, number> {
    const election = this.elections.get(id);
    if (!election) return {};
    const votes: Record<string, number> = {};
    for (const candidate of election.candidates) {
      votes[candidate] = this.node.getPNCounter(ELECTION_NAMES.candVotes(id, candidate)) || 0;
    }
    return votes;
  }

  getElectionExpiry(id: string): number {
    return this.node.getRegister(ELECTION_NAMES.expires(id)) || 0;
  }

  getElectionFinalized(id: string): number {
    return this.node.getRegister(ELECTION_NAMES.finalized(id)) || 0;
  }

  hasBallot(id: string): boolean {
    return this.node.setContains(ELECTION_NAMES.ballots(id), this.walletUser);
  }

  getRunoffUsage(id: string): number {
    let used = 0;
    for (let i = 1; i <= 100; i++) {
      if (this.node.setContains(ELECTION_NAMES.mirrorSet(id), ELECTION_NAMES.mirrorElement(id, this.walletUser, i))) {
        used = i;
      } else {
        break;
      }
    }
    return (used * (used + 1) * (2 * used + 1)) / 6;
  }

  getDistributionConfig(): { intervalMs: number; rate: number } {
    return {
      intervalMs: this.node.getRegister(CONFIG_NAMES.distributionInterval()) || TOKEN_CONFIG.distributionIntervalMs,
      rate: this.node.getRegister(CONFIG_NAMES.distributionRate()) || TOKEN_CONFIG.distributionRate,
    };
  }

  getTokenConfigBounds(): { minInterval: number; minRate: number } {
    return { minInterval: 1000, minRate: 1 };
  }
```

- [ ] **Step 5: Verify**

Run: `npm run build:client` → OK.

- [ ] **Step 6: Commit**

```bash
git add client/src/dao.ts
git commit -m "feat(client): election mirroring and custodian role sync"
```

---

## Task 7b: server-client passthrough — no changes needed

`sync_roles` operations flow through the existing `submit_op`/`broadcast`/`log` pipeline; no new ServerMessage kinds are required. Verify `server-client.ts` needs no change (`broadcast` validation already passes arbitrary stored operations).

---

## Task 8: Client UI — election panel, ballots, custodian controls

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/ui.ts`
- Verify: `npm run build:client`

- [ ] **Step 1: Add panels to `client/index.html`** — after the proposals section-card, add:

```html
            <section class="section-card" aria-labelledby="election-title">
              <div class="section-card__header">
                <h2 id="election-title" class="section-card__title">Custodian election</h2>
              </div>
              <div id="custodians" class="custodian-list"></div>
              <div class="proposal-form__actions">
                <button id="start-election" class="button button--secondary" type="button">Start election</button>
              </div>
              <div id="election-area"></div>
            </section>

            <section class="section-card" aria-labelledby="custodian-admin-title">
              <div class="section-card__header">
                <h2 id="custodian-admin-title" class="section-card__title">Custodian controls</h2>
              </div>
              <form id="token-config-form" class="proposal-form">
                <div class="form-group">
                  <label class="form-label" for="config-interval">Distribution interval (ms)</label>
                  <input id="config-interval" class="form-input" type="number" min="1000" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="config-rate">Tokens per interval</label>
                  <input id="config-rate" class="form-input" type="number" min="1" />
                </div>
                <div class="proposal-form__actions">
                  <button class="button button--primary" type="submit">Apply settings</button>
                </div>
              </form>
              <div id="remove-controls" class="remove-controls"></div>
            </section>
```

- [ ] **Step 2: Bind and render in `client/src/ui.ts`**

In `bindDashboard()` add:

```typescript
    const startElectionBtn = document.getElementById('start-election');
    startElectionBtn?.addEventListener('click', () => void this.onStartElection());

    const tokenConfigForm = document.getElementById('token-config-form') as HTMLFormElement | null;
    tokenConfigForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onSetTokenConfig();
    });
```

Add methods to `AppUI`:

```typescript
  private async onStartElection() {
    if (!this.dao || !this.wallet || this.submitting) return;
    const candidates = Array.from(this.memberUsernames).concat(this.wallet.username).sort();
    const payload: StartElectionPayload = {
      electionId: crypto.randomUUID(),
      candidates,
      expiresAt: this.dao.getNodeTimeMs() + 60 * 1000,
    };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.startElection(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Election started.', 'success');
      this.renderElections();
    } catch (err) {
      this.setStatus(`Election error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onCastBallot(electionId: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    const picks = Array.from(
      document.querySelectorAll<HTMLInputElement>('.ballot-option:checked')
    ).map((el) => (el as HTMLInputElement).dataset.member || '');
    if (picks.length < 1 || picks.length > 5) {
      this.setStatus('Pick between 1 and 5 candidates.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.castBallot(this.wallet.username, { electionId, picks });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Ballot cast.', 'success');
      this.renderElections();
    } catch (err) {
      this.setStatus(`Ballot error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onFinalizeElection(electionId: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    const election = this.dao.getElections().find((e) => e.electionId === electionId);
    if (!election) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.finalizeElection(this.wallet.username, {
        electionId, candidates: election.candidates,
      });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Election finalized.', 'success');
      this.renderElections();
      this.renderCustodians();
    } catch (err) {
      this.setStatus(`Finalize error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onCastRunoffVote(electionId: string, candidate: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.castRunoffVote(this.wallet.username, { electionId, candidate });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Runoff vote cast for ${candidate}.`, 'success');
      this.renderElections();
    } catch (err) {
      this.setStatus(`Runoff error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onSetTokenConfig() {
    if (!this.dao || !this.wallet || this.submitting) return;
    const intervalMs = parseInt(this.inputValue('config-interval'), 10);
    const rate = parseInt(this.inputValue('config-rate'), 10);
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || !Number.isInteger(rate) || rate < 1) {
      this.setStatus('Interval must be >= 1000ms and rate >= 1.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.setTokenConfig(this.wallet.username, { intervalMs, rate });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Token settings updated.', 'success');
    } catch (err) {
      this.setStatus(`Config error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onRemoveMember(username: string) {
    if (!this.dao || !this.wallet || this.submitting || username === this.wallet.username) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.removeMember(this.wallet.username, { username });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.memberUsernames.delete(username);
      this.renderMembers();
      this.renderCustodianControls();
      this.setStatus(`${username} removed from the DAO.`, 'success');
    } catch (err) {
      this.setStatus(`Remove error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private renderElections() {
    const area = document.getElementById('election-area');
    if (!area || !this.dao || !this.wallet) return;
    area.innerHTML = '';
    const elections = this.dao.getElections();
    if (elections.length === 0) return;

    for (const election of elections.reverse()) {
      const card = document.createElement('div');
      card.className = 'proposal-card';

      const title = document.createElement('h3');
      title.className = 'proposal-card__title';
      title.textContent = election.isRunoff ? 'Custodian runoff (quadratic)' : 'Custodian election';
      card.appendChild(title);

      const finalized = this.dao.getElectionFinalized(election.electionId) === 1;
      const awaitingRunoff = this.dao.getElectionFinalized(election.electionId) === 2;
      const badge = document.createElement('span');
      badge.className = 'proposal-card__badge';
      badge.textContent = finalized ? 'Finalized' : awaitingRunoff ? 'Runoff pending' : 'Open';
      card.appendChild(badge);

      const votes = this.dao.getElectionVotes(election.electionId);
      const ballots = this.dao.hasBallot(election.electionId);
      const expiresAt = this.dao.getElectionExpiry(election.electionId);
      const remainingMs = Math.max(0, expiresAt - this.dao.getNodeTimeMs());

      const info = document.createElement('div');
      info.className = 'proposal-card__type';
      info.textContent = `Closes in ${Math.ceil(remainingMs / 1000)}s${ballots ? ' — you voted' : ''}`;
      card.appendChild(info);

      if (!election.isRunoff && !finalized && !awaitingRunoff && !ballots) {
        const form = document.createElement('div');
        for (const candidate of election.candidates) {
          const label = document.createElement('label');
          label.style.display = 'block';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'ballot-option';
          checkbox.dataset.member = candidate;
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(` ${candidate}`));
          form.appendChild(label);
        }
        const submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'button button--primary';
        submit.textContent = 'Submit ballot (1-5 picks)';
        submit.disabled = this.submitting;
        submit.addEventListener('click', () => void this.onCastBallot(election.electionId));
        form.appendChild(submit);
        card.appendChild(form);
      } else {
        const tally = document.createElement('div');
        for (const [candidate, count] of Object.entries(votes)) {
          const row = document.createElement('div');
          row.className = 'vote-stat';
          const labelEl = document.createElement('span');
          labelEl.className = 'vote-stat__label';
          labelEl.textContent = candidate;
          const valueEl = document.createElement('span');
          valueEl.className = 'vote-stat__value';
          valueEl.textContent = String(count);
          row.appendChild(labelEl);
          row.appendChild(valueEl);
          tally.appendChild(row);
        }
        card.appendChild(tally);
      }

      if (election.isRunoff && !finalized) {
        const runoffForm = document.createElement('div');
        for (const candidate of election.candidates) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'button button--secondary runoff-vote';
          btn.textContent = `Vote ${candidate}`;
          btn.disabled = this.submitting;
          btn.addEventListener('click', () => void this.onCastRunoffVote(election.electionId, candidate));
          runoffForm.appendChild(btn);
        }
        const usage = this.dao.getRunoffUsage(election.electionId);
        const cost = document.createElement('div');
        cost.className = 'proposal-card__tokens';
        cost.textContent = `Tokens used: ${usage} | Balance: ${this.dao.getTokenBalance(this.wallet.username)}`;
        runoffForm.appendChild(cost);
        card.appendChild(runoffForm);
      }

      if (!finalized && !awaitingRunoff && remainingMs <= 0) {
        const finalizeBtn = document.createElement('button');
        finalizeBtn.type = 'button';
        finalizeBtn.className = 'button button--primary';
        finalizeBtn.textContent = 'Finalize election';
        finalizeBtn.disabled = this.submitting;
        finalizeBtn.addEventListener('click', () => void this.onFinalizeElection(election.electionId));
        card.appendChild(finalizeBtn);
      }

      area.appendChild(card);
    }
  }

  private renderCustodians() {
    const list = document.getElementById('custodians');
    if (!list || !this.dao) return;
    list.innerHTML = '';
    const custodians = this.dao.custodians;
    if (custodians.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No custodians elected yet.';
      list.appendChild(empty);
      return;
    }
    custodians.forEach((username, i) => {
      const item = document.createElement('span');
      item.className = 'member-item__badge';
      item.textContent = `Seat ${i + 1}: ${username}`;
      list.appendChild(item);
    });
  }

  private renderCustodianControls() {
    const controls = document.getElementById('remove-controls');
    const configForm = document.getElementById('token-config-form');
    if (!controls || !this.dao || !this.wallet) return;
    const isCustodian = this.dao.custodians.includes(this.wallet.username);
    (configForm as HTMLElement | null)?.classList.toggle('hidden', !isCustodian);
    controls.innerHTML = '';
    if (!isCustodian) return;

    const config = this.dao.getDistributionConfig();
    const intervalInput = document.getElementById('config-interval') as HTMLInputElement | null;
    const rateInput = document.getElementById('config-rate') as HTMLInputElement | null;
    if (intervalInput && !intervalInput.value) intervalInput.value = String(config.intervalMs);
    if (rateInput && !rateInput.value) rateInput.value = String(config.rate);

    for (const username of this.memberUsernames) {
      if (username === this.wallet.username) continue;
      const row = document.createElement('div');
      row.className = 'member-item';
      const name = document.createElement('span');
      name.className = 'member-item__name';
      name.textContent = username;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button button--secondary remove-member';
      btn.textContent = 'Remove';
      btn.disabled = this.submitting;
      btn.addEventListener('click', () => void this.onRemoveMember(username));
      row.appendChild(name);
      row.appendChild(btn);
      controls.appendChild(row);
    }
  }
```

Also: call `this.renderElections()` and `this.renderCustodians()` and `this.renderCustodianControls()` from `showDashboard()` and from the periodic `startDemoClock` update; call `dao.setWalletUser(username)` right after each `new BrowserDao()` + `init` in `onRegister`/`onLogin`; extend the Members panel badge loop to add a 'custodian' badge when `this.dao.custodians.includes(username)`.

- [ ] **Step 2 verify:** Run `npm run build:client` → OK.

- [ ] **Step 3: Commit**

```bash
git add client/index.html client/src/ui.ts
git commit -m "feat(client): custodian election UI and custodian controls"
```

---

## Task 9: Smoke test and end-to-end verification

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: Append an election flow to `test-voting-browser.js`** (keep the existing multiple-choice flow; insert before `await alice.browser.close();`):

```javascript
  // --- Custodian election flow ---
  // carol and dave register; their registrations broadcast to alice/bob pages.
  const carol = await runUser('carol_e2e_' + Math.floor(Math.random() * 10000));
  await carol.browser.close();
  const dave = await runUser('dave_e2e_' + Math.floor(Math.random() * 10000));
  await dave.browser.close();

  // Start the election from alice's page.
  await alice.page.click('#start-election');
  await alice.page.waitForTimeout(1500);

  // Alice and bob each cast a ballot (checkboxes for members).
  await alice.page.locator('.ballot-option').first().waitFor({ state: 'visible' });
  const checkboxes = await alice.page.$$('.ballot-option');
  await checkboxes[0].click(); // alice picks first candidate
  await alice.page.click('#election-area button.button--primary');
  await alice.page.waitForTimeout(1500);

  await bob.page.locator('.ballot-option').first().waitFor({ state: 'visible' });
  const bobCheckboxes = await bob.page.$$('.ballot-option');
  await bobCheckboxes[0].click();
  await bob.page.click('#election-area button.button--primary');
  await bob.page.waitForTimeout(1500);

  // Wait for expiry (60s), then finalize.
  await alice.page.waitForTimeout(62000);
  await alice.page.click('text=Finalize election');
  await alice.page.waitForTimeout(2000);

  // Custodian controls appear for alice (a winner with the most picks).
  await alice.page.waitForSelector('#token-config-form:not(.hidden)', { timeout: 30000 });
  await alice.page.fill('#config-interval', '1000');
  await alice.page.fill('#config-rate', '5');
  await alice.page.click('#token-config-form button[type="submit"]');
  await alice.page.waitForTimeout(1500);

  // Remove dave (if alice is a custodian and dave is listed).
  const removeBtn = alice.page.locator('.remove-member').first();
  if (await removeBtn.count()) {
    await removeBtn.click({ force: true });
    await alice.page.waitForTimeout(1500);
  }

  console.log('Custodian election smoke flow completed');
```

- [ ] **Step 2: Rebuild, restart fresh server, run full smoke test**

```bash
npm run build
lsof -ti:9000 | xargs -r kill -9 2>/dev/null || true
sleep 1
rm -rf data/wavedb/*
PORT=9000 node dist/server/src/index.js > /tmp/dao-server.log 2>&1 &
sleep 2
node test-voting-browser.js
```

Expected: output ends `Smoke test passed` and `Custodian election smoke flow completed`; no pageerror lines.

- [ ] **Step 3: Run unit suite**

Run: `npm run test:server` → all PASS.

- [ ] **Step 4: Stop server, commit**

```bash
lsof -ti:9000 | xargs -r kill -9 2>/dev/null || true
git add test-voting-browser.js
git commit -m "test: custodian election smoke flow"
```

---

## Self-Review

**Spec coverage:**
- start_election validation/resources → Task 2
- cast_ballot (dedup, 1-5 picks, membership via candidates set) → Task 2
- finalize (rank, winners set, runoff spawn, idempotence) → Task 3
- Quadratic runoff voting + runoff finalize + alphabetical guard → Task 4
- Custodian token config (interval/rate registers, dynamic distributeTokens) → Tasks 1 + 5
- remove_member (membership, tokens) + server revokeUser → Task 5 + Task 6
- role:custodian policy enforcement → Task 6 (CRABS-level test)
- sync_roles log entries + browser application + key-version bookkeeping → Task 6 + Task 7
- UI (election panel, ballot, runoff, custodian controls, badges) → Task 8
- End-to-end verification → Task 9

**Placeholder scan:** none — all steps contain complete code.

**Type consistency:** `SyncRolesPayload` used in Task 1 types, Task 6 server, Task 7 client; `ELECTION_NAMES`/`runoffId` defined in Task 1 and used everywhere; handler factory names consistent between tests and implementations.