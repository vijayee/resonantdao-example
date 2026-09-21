# Multiple Choice Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give proposals creator-defined option lists so both Direct and Quadratic proposals support binary (default Yes/No) or 2–10 custom options, with a unified vote payload and strict-majority outcome rule.

**Architecture:** Every proposal carries `options: string[]`. The create handler writes an option-count register and one ORSet + PNCounter per option. The vote handler is choice-agnostic (same dedup/cost logic, vote lands in the chosen option's set). The execute handler scans all option counters and passes only on a strict majority, recording the winning option index.

**Tech Stack:** TypeScript, CRABS WASM handlers (`registerHandlerJs`), Jest/ts-jest unit tests with a mock CRABS state, Playwright smoke test.

**Spec:** `docs/superpowers/specs/2026-09-03-multiple-choice-voting-design.md`

**Note on the winner register:** the spec says `winner = option index or -1`. The CRABS register API may not accept a negative initial value, so the implementation stores `winnerIndex + 1` with `0 = no winner`. This is an encoding detail; all readers use the same convention.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `shared/src/types.ts` | `ProposalPayload.options`, `VotePayload.choice` |
| `shared/src/policies.ts` | New TOKEN_NAMES: option count/sets/counters, winner register |
| `shared/src/handlers.ts` | Unified create/vote/execute handlers for N options |
| `server/test/handlers.test.ts` | Mock-state unit tests (updated + new cases) |
| `server/test/crabs.test.ts` | CRABS-level test reading per-option tallies |
| `server/src/crabs.ts` | `DaoNode.getProposalOptionVotes` |
| `client/index.html` | Options input on the proposal form |
| `client/src/dao.ts` | `BrowserDao.getProposalOptionVotes` |
| `client/src/ui.ts` | Options parsing, per-option vote buttons and tallies; debug-log cleanup |
| `test-voting-browser.js` | Playwright smoke test for multiple-choice flows |

---

## Task 1: Unified option model in shared code

**Files:**
- Modify: `shared/src/types.ts`
- Modify: `shared/src/policies.ts`
- Modify: `shared/src/handlers.ts`
- Modify: `server/test/handlers.test.ts`

- [ ] **Step 1: Update `shared/src/types.ts`**

Replace `ProposalPayload` and `VotePayload` with:

```typescript
export interface ProposalPayload {
  proposalId: string;
  title: string;
  description: string;
  proposalType: ProposalType;
  options: string[]; // 2-10 non-empty, unique options; binary = ['Yes','No']
  expiresAt: number; // epoch ms
}

export interface VotePayload {
  proposalId: string;
  choice: number; // index into options (0-based)
}
```

- [ ] **Step 2: Update `shared/src/policies.ts` TOKEN_NAMES**

Add these four entries inside the `TOKEN_NAMES` object (keep the existing entries):

```typescript
export const TOKEN_NAMES = {
  balance: (username: string) => `tokens:${username}`,
  lastDistribution: (username: string) => `tokens:${username}:last_dist`,
  proposalMirrorSet: (proposalId: string) => `tokens:${proposalId}:mirror`,
  proposalMirrorElement: (proposalId: string, username: string, n: number) => `tokens:${proposalId}:${username}:${n}`,
  voteTypeSet: (proposalId: string) => `votes:${proposalId}:voters`,
  proposalType: (proposalId: string) => `proposals:${proposalId}:type`,
  proposalExpiresAt: (proposalId: string) => `proposals:${proposalId}:expires`,
  proposalExecuted: (proposalId: string) => `proposals:${proposalId}:executed`,
  proposalPassed: (proposalId: string) => `proposals:${proposalId}:passed`,
  proposalWinner: (proposalId: string) => `proposals:${proposalId}:winner`,
  proposalOptionCount: (proposalId: string) => `proposals:${proposalId}:option_count`,
  optionVoteSet: (proposalId: string, index: number) => `votes:${proposalId}:opt${index}`,
  optionVoteCount: (proposalId: string, index: number) => `votes:${proposalId}:opt${index}_count`,
} as const;
```

- [ ] **Step 3: Rewrite `server/test/handlers.test.ts` with updated + new tests**

Replace the whole file with:

```typescript
import {
  HandlerState,
  HandlerOperation,
} from 'crabs-wasm';
import {
  makeCreateProposalHandler,
  makeVoteHandler,
  makeExecuteHandler,
} from '../../shared/src/handlers';
import { TOKEN_CONFIG, VOTE_THRESHOLD } from '../../shared/src/policies';

class MockNode {
  orSets = new Set<string>();
  registers = new Map<string, number>();
  pnCounters = new Map<string, number>();
  oneShotSets = new Set<string>();

  addORSet(name: string) {
    if (this.orSets.has(name)) throw new Error('duplicate_operation');
    this.orSets.add(name);
  }
  addRegister(name: string, initial = 0) {
    if (this.registers.has(name)) throw new Error('duplicate_operation');
    this.registers.set(name, initial);
  }
  addPNCounter(name: string) {
    if (this.pnCounters.has(name)) throw new Error('duplicate_operation');
    this.pnCounters.set(name, 0);
  }
  addOneShotSet(name: string) {
    if (this.oneShotSets.has(name)) throw new Error('duplicate_operation');
    this.oneShotSets.add(name);
  }
}

class MockState implements HandlerState {
  private sets = new Map<string, Set<string>>();
  private setTags = new Map<string, Map<string, string>>();
  private registers = new Map<string, number>();
  private pnCounters = new Map<string, number>();
  private node: MockNode;

  constructor(node: MockNode) {
    this.node = node;
  }

  private ensureSet(name: string) {
    if (!this.sets.has(name)) {
      this.sets.set(name, new Set());
      this.setTags.set(name, new Map());
    }
  }

  incrementCounter(): void { throw new Error('not implemented'); }
  incrementPNCounter(name: string, delta = 1): void {
    this.pnCounters.set(name, (this.pnCounters.get(name) || 0) + delta);
  }
  decrementPNCounter(name: string, delta = 1): void {
    this.pnCounters.set(name, (this.pnCounters.get(name) || 0) - delta);
  }
  setRegister(name: string, value: number, _nodeId?: string): void {
    this.registers.set(name, value);
  }
  setAdd(name: string, element: string, tag = element): void {
    this.ensureSet(name);
    this.sets.get(name)!.add(element);
    this.setTags.get(name)!.set(element, tag);
  }
  setRemove(name: string, element: string): void {
    this.ensureSet(name);
    this.sets.get(name)!.delete(element);
    this.setTags.get(name)!.delete(element);
  }
  flagSet(): void { throw new Error('not implemented'); }
  getCounter(): number { return 0; }
  getPNCounter(name: string): number {
    return this.pnCounters.get(name) || 0;
  }
  getRegister(name: string): number {
    return this.registers.get(name) ?? this.node.registers.get(name) ?? 0;
  }
  setContains(name: string, element: string): boolean {
    return this.sets.has(name) && this.sets.get(name)!.has(element);
  }
}

function makeOp(type: string, signerId: string, payload: object): HandlerOperation {
  return {
    type,
    signerId,
    nodeId: 'browser',
    payload: JSON.stringify(payload),
  };
}

function setupProposal(
  node: MockNode,
  state: MockState,
  proposalId: string,
  proposalType: 'direct' | 'quadratic',
  expiresAt: number,
  options: string[] = ['Yes', 'No'],
  nowMs = 0
) {
  const handler = makeCreateProposalHandler(node, { getTimeMs: () => nowMs });
  const res = handler(state, makeOp('create_proposal', 'alice', {
    proposalId,
    title: 'Test',
    description: 'Desc',
    proposalType,
    options,
    expiresAt,
  }));
  expect(res).toBe(0);
}

function initUser(state: MockState, username: string, nowMs: number) {
  state.setRegister(`tokens:${username}`, TOKEN_CONFIG.initialTokens);
  state.setRegister(`tokens:${username}:last_dist`, nowMs > 0 ? nowMs : 1);
}

describe('Governance handlers', () => {
  it('rejects duplicate direct votes from the same user', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'direct', 1000);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(2);

    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 1 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(2);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(0);
  });

  it('records multiple-choice direct votes per option and rejects duplicates', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'direct', 1000, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 2 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(state.getPNCounter('votes:p1:opt2_count')).toBe(1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(1);

    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 1 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(0);
  });

  it('rejects votes for unknown option indexes', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'direct', 1000, ['Alpha', 'Beta']);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 2 }))).toBe(-1);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: -1 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(0);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(0);
  });

  it('charges n^2 across different quadratic options and caps at the mirrored balance', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);

    setupProposal(node, state, 'p1', 'quadratic', 1000, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => 0 });
    // Cumulative costs after n votes: 1, 5, 14. Balance is 20, so three votes succeed.
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 1 }))).toBe(0);
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 2 }))).toBe(0);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(1);
    expect(state.getPNCounter('votes:p1:opt1_count')).toBe(1);
    expect(state.getPNCounter('votes:p1:opt2_count')).toBe(1);

    // Fourth vote would bring cumulative cost to 30, exceeding balance 20.
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(-1);
    expect(state.getPNCounter('votes:p1:opt0_count')).toBe(1);
  });

  it('distributes contribution tokens at the configured interval', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const startTime = 1000;
    initUser(state, 'alice', startTime);

    setupProposal(node, state, 'p1', 'quadratic', startTime + TOKEN_CONFIG.distributionIntervalMs * 3);

    const vote = makeVoteHandler({ getTimeMs: () => startTime + TOKEN_CONFIG.distributionIntervalMs });
    expect(vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }))).toBe(0);

    expect(state.getRegister('tokens:alice')).toBe(
      TOKEN_CONFIG.initialTokens + TOKEN_CONFIG.distributionRate
    );
  });

  it('rejects proposals with invalid option lists', () => {
    const node = new MockNode();
    const state = new MockState(node);
    const handler = makeCreateProposalHandler(node, { getTimeMs: () => 0 });

    const base = { title: 'T', description: 'D', proposalType: 'direct' as const };
    // Too few options
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad1', options: ['Only'], expiresAt: 1000 }))).toBe(-1);
    // Duplicate labels
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad2', options: ['A', 'A'], expiresAt: 1000 }))).toBe(-1);
    // Too many options
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad3', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], expiresAt: 1000 }))).toBe(-1);
    // Empty label
    expect(handler(state, makeOp('create_proposal', 'alice', { ...base, proposalId: 'bad4', options: ['A', ''], expiresAt: 1000 }))).toBe(-1);
    // Nothing was created
    expect(state.getRegister('proposals:bad1:option_count')).toBe(0);
  });

  it('passes a binary proposal on strict majority, equivalently to yes > no', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);
    initUser(state, 'bob', 0);

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 0 }));

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'alice', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(1);
    expect(state.getRegister('proposals:p1:winner')).toBe(1); // option index 0 + 1
    expect(state.getRegister('proposals:p1:executed')).toBe(1);
  });

  it('fails a tied binary proposal after expiry', () => {
    const node = new MockNode();
    const state = new MockState(node);
    initUser(state, 'alice', 0);
    initUser(state, 'bob', 0);

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    vote(state, makeOp('vote', 'alice', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'bob', { proposalId: 'p1', choice: 1 }));

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'alice', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(0);
    expect(state.getRegister('proposals:p1:winner')).toBe(0);
    expect(state.getRegister('proposals:p1:executed')).toBe(1);
  });

  it('records a majority winner on a multiple-choice proposal', () => {
    const node = new MockNode();
    const state = new MockState(node);
    for (const voter of ['v1', 'v2', 'v3']) {
      initUser(state, voter, 0);
    }

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    vote(state, makeOp('vote', 'v1', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'v2', { proposalId: 'p1', choice: 0 }));
    vote(state, makeOp('vote', 'v3', { proposalId: 'p1', choice: 1 }));

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'v1', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(1);
    expect(state.getRegister('proposals:p1:winner')).toBe(1); // 'Alpha' = index 0 + 1
    expect(state.getRegister('proposals:p1:executed')).toBe(1);
  });

  it('fails a plurality without majority (5/3/3 split)', () => {
    const node = new MockNode();
    const state = new MockState(node);

    const startTime = 1000;
    setupProposal(node, state, 'p1', 'direct', startTime + 100, ['Alpha', 'Beta', 'Gamma']);

    const vote = makeVoteHandler({ getTimeMs: () => startTime });
    const voters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    voters.forEach((v, i) => {
      const choice = i < 5 ? 0 : i < 8 ? 1 : 2;
      expect(vote(state, makeOp('vote', v, { proposalId: 'p1', choice }))).toBe(0);
    });

    const execute = makeExecuteHandler({ getTimeMs: () => startTime + 101, threshold: VOTE_THRESHOLD });
    expect(execute(state, makeOp('execute', 'a', { proposalId: 'p1' }))).toBe(0);

    expect(state.getRegister('proposals:p1:passed')).toBe(0);
    expect(state.getRegister('proposals:p1:winner')).toBe(0);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx jest server/test/handlers.test.ts`
Expected: FAIL — handlers still read the old `vote: 'yes' | 'no'` payload, so votes return -1 and tallies stay 0.

- [ ] **Step 5: Update `shared/src/handlers.ts`**

Apply these changes to the file:

1. Add after `isValidProposalType`:

```typescript
function isValidOptions(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 10 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}
```

2. In `makeCreateProposalHandler`, extend the payload guard and replace the yes/no resource creation + add option resources. The guard becomes:

```typescript
const payload: ProposalPayload = JSON.parse(op.payload || '{}');
if (
  !isNonEmptyString(payload.proposalId) ||
  !isNonEmptyString(payload.title) ||
  !isValidProposalType(payload.proposalType) ||
  !isValidOptions(payload.options)
) {
  return -1;
}
```

Replace the four yes/no `addORSet`/`addPNCounter` lines with:

```typescript
const optionCount = payload.options.length;
try { node.addRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
for (let i = 0; i < optionCount; i++) {
  try { node.addORSet(TOKEN_NAMES.optionVoteSet(payload.proposalId, i)); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
  try { node.addPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, i)); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
}
```

And add after the existing `proposalPassed` register line, plus a winner register:

```typescript
try { node.addRegister(TOKEN_NAMES.proposalWinner(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
```

Finally, add after the `proposalExpiresAt` `setRegister` line:

```typescript
state.setRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId), optionCount, op.signerId);
```

3. In `makeVoteHandler`, replace the payload guard and vote application. The guard becomes:

```typescript
const payload: VotePayload = JSON.parse(op.payload || '{}');
const optionCount = state.getRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId)) || 0;
if (
  !isNonEmptyString(payload.proposalId) ||
  optionCount <= 0 ||
  !Number.isInteger(payload.choice) ||
  payload.choice < 0 ||
  payload.choice >= optionCount
) {
  return -1;
}
```

Keep the expiry check, direct dedup, and quadratic cost logic unchanged. Delete the entire direct "remove opposite vote" block (`if (proposalType === 1) { const opposite = ... }`) and the old `voteKey`/`setAdd`/`incrementPNCounter` lines. The tail of the handler becomes:

```typescript
const voteKey = `${op.signerId}:${voteNumber}`;
state.setAdd(TOKEN_NAMES.optionVoteSet(payload.proposalId, payload.choice), voteKey, op.signerId);
state.incrementPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, payload.choice), 1, op.signerId);
return 0;
```

4. In `makeExecuteHandler`, replace the vote-counting body. The handler becomes:

```typescript
export function makeExecuteHandler(
  config: { getTimeMs?: () => number; threshold?: number } = {}
) {
  const threshold = config.threshold ?? VOTE_THRESHOLD;
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ExecutePayload = JSON.parse(op.payload || '{}');
    const optionCount = state.getRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId)) || 0;
    if (!isNonEmptyString(payload.proposalId) || optionCount <= 0) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId)) || 0;

    let leaderIdx = 0;
    let leaderCount = 0;
    let total = 0;
    for (let i = 0; i < optionCount; i++) {
      const count = state.getPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, i)) || 0;
      total += count;
      if (count > leaderCount) {
        leaderCount = count;
        leaderIdx = i;
      }
    }
    const hasMajority = total > 0 && leaderCount * 2 > total;

    if (expiresAt > 0 && nowMs < expiresAt) {
      // Before expiry, only auto-execute if the leader reached the vote
      // threshold AND already holds a strict majority of votes cast so far.
      if (!(leaderCount >= threshold && hasMajority)) {
        return 0;
      }
    }

    state.setRegister(TOKEN_NAMES.proposalPassed(payload.proposalId), hasMajority ? 1 : 0, op.signerId);
    // Register stores winnerIndex + 1; 0 = no winner (avoids a negative
    // register initial value, which the CRABS WASM wrapper does not guarantee).
    state.setRegister(TOKEN_NAMES.proposalWinner(payload.proposalId), hasMajority ? leaderIdx + 1 : 0, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalExecuted(payload.proposalId), 1, op.signerId);
    state.setAdd(STATE_NAMES.executedProposals, payload.proposalId, op.signerId);
    return 0;
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest server/test/handlers.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Run full server build and suite**

Run: `npm run build:server && npm run test:server`
Expected: build OK; `crabs.test.ts` still passes (it uses a binary payload with `options` now required — if it fails because `create_proposal` payload lacks `options`, update its `payloadJson` to include `options: ['Yes', 'No']`).

- [ ] **Step 8: Commit**

```bash
git add shared/src/types.ts shared/src/policies.ts shared/src/handlers.ts server/test/handlers.test.ts server/test/crabs.test.ts
git commit -m "feat: unified multiple-choice options for proposals"
```

---

## Task 2: Server per-option read API

**Files:**
- Modify: `server/src/crabs.ts`
- Test: `server/test/crabs.test.ts`

- [ ] **Step 1: Add failing assertion to `server/test/crabs.test.ts`**

Append to the end of the existing test (after the `setContains('proposals', 'p1')` assertion):

```typescript
    expect(dao.getProposalOptionVotes('p1')).toEqual([0, 0]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest server/test/crabs.test.ts`
Expected: FAIL — `getProposalOptionVotes is not a function`.

- [ ] **Step 3: Implement in `server/src/crabs.ts`**

Replace the existing `getProposalVotes` method with:

```typescript
  getProposalOptionVotes(proposalId: string): number[] {
    const optionCount = this.node.getRegister(TOKEN_NAMES.proposalOptionCount(proposalId)) || 0;
    const counts: number[] = [];
    for (let i = 0; i < optionCount; i++) {
      counts.push(this.node.getPNCounter(TOKEN_NAMES.optionVoteCount(proposalId, i)) || 0);
    }
    return counts;
  }
```

(`TOKEN_NAMES` is already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest server/test/crabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/crabs.ts server/test/crabs.test.ts
git commit -m "feat(server): per-option vote tallies on DaoNode"
```

---

## Task 3: Client DAO, form, and per-option UI

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/dao.ts`
- Modify: `client/src/ui.ts`

- [ ] **Step 1: Add the Options input to `client/index.html`**

After the `proposal-type` form-group div, add:

```html
                <div class="form-group">
                  <label class="form-label" for="proposal-options">Options (comma-separated, optional)</label>
                  <input id="proposal-options" class="form-input" type="text" placeholder="e.g. Alpha, Beta, Gamma — leave empty for Yes/No" />
                </div>
```

- [ ] **Step 2: Update `client/src/dao.ts`**

Replace `getProposalVotes` with:

```typescript
  getProposalOptionVotes(id: string): number[] {
    const optionCount = this.node.getRegister(`proposals:${id}:option_count`) || 0;
    const counts: number[] = [];
    for (let i = 0; i < optionCount; i++) {
      counts.push(this.node.getPNCounter(`votes:${id}:opt${i}_count`) || 0);
    }
    return counts;
  }
```

- [ ] **Step 3: Update `client/src/ui.ts` — proposal creation**

In `onCreateProposal`, after reading title/description and before building the payload, parse options and set `expiresAt` from node time (keep the existing node-time expiry line):

```typescript
    const rawOptions = this.inputValue('proposal-options');
    const parsed = rawOptions.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    let options: string[];
    if (parsed.length === 0) {
      options = ['Yes', 'No'];
    } else if (parsed.length >= 2 && parsed.length <= 10 && new Set(parsed).size === parsed.length) {
      options = parsed;
    } else {
      this.setStatus('Options must be 2-10 unique, non-empty comma-separated values.', 'error');
      return;
    }

    const proposalType = this.inputValue('proposal-type') as 'direct' | 'quadratic';
    // Use the DAO node time so expiry stays consistent with the local
    // state machine clock.
    const nowMs = this.dao.getNodeTimeMs();
    const payload: ProposalPayload = {
      proposalId: crypto.randomUUID(),
      title,
      description,
      proposalType: proposalType === 'quadratic' ? 'quadratic' : 'direct',
      options,
      expiresAt: nowMs + 60 * 1000,
    };
```

- [ ] **Step 4: Update `client/src/ui.ts` — vote action**

Replace `onVote` with (also removes the temporary `[onVote pre]`/`[onVote error]` debug logging added during the expiry investigation):

```typescript
  private async onVote(proposalId: string, choice: number) {
    if (!this.dao || !this.wallet || this.submitting) return;

    const payload: VotePayload = { proposalId, choice };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.vote(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      if (this.dao.getProposalType(proposalId) === 'direct') {
        this.votedProposals.add(proposalId);
      }
      this.setStatus(`Voted.`, 'success');
      this.renderProposals();
    } catch (err) {
      this.setStatus(`Vote error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
      this.renderProposals();
    }
  }
```

Also remove the temporary debug log from `safeExecuteRemote` (delete the `console.log('[safeExecuteRemote caught]', ...)` line).

- [ ] **Step 5: Update `client/src/ui.ts` — per-option tallies and buttons**

In `createProposalCard`, replace the `votes` section (the two `vote-stat` blocks for yes/no) with:

```typescript
    const options = proposal.options ?? ['Yes', 'No'];
    const counts = this.dao.getProposalOptionVotes(proposal.proposalId);

    const voteRows = document.createElement('div');
    voteRows.className = 'proposal-card__votes';
    options.forEach((label, i) => {
      const row = document.createElement('div');
      row.className = 'vote-stat';
      const labelEl = document.createElement('span');
      labelEl.className = 'vote-stat__label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'vote-stat__value';
      valueEl.textContent = String(counts[i] ?? 0);
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      voteRows.appendChild(row);
    });
    li.appendChild(voteRows);
```

And replace the yes/no action buttons with one button per option (keep the Execute button after them):

```typescript
    options.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button button--secondary vote-option';
      btn.textContent = label;
      btn.disabled = actionsDisabled;
      btn.addEventListener('click', () => void this.onVote(proposal.proposalId, i));
      actions.appendChild(btn);
    });
```

- [ ] **Step 6: Build the client**

Run: `npm run build:client`
Expected: OK, no type errors.

- [ ] **Step 7: Commit**

```bash
git add client/index.html client/src/dao.ts client/src/ui.ts
git commit -m "feat(client): multiple-choice proposal options and per-option voting"
```

---

## Task 4: Update smoke test and verify end-to-end

**Files:**
- Modify: `test-voting-browser.js`

- [ ] **Step 1: Rewrite `test-voting-browser.js`**

```javascript
const { chromium } = require('playwright');

const PASSWORD = 'TestPassword123!';
const BASE_URL = 'http://localhost:9000/';

async function runUser(username, headless = true) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(`[${username}]`, msg.text()));
  page.on('pageerror', (err) => console.log(`[${username} pageerror]`, err.message));

  await page.goto(BASE_URL);
  await page.waitForSelector('#register-username', { timeout: 30000 });

  await page.fill('#register-username', username);
  await page.fill('#register-password', PASSWORD);
  await page.fill('#register-password-confirm', PASSWORD);
  await page.click('#register-form button[type="submit"]');
  await page.waitForSelector('#dashboard:not(.hidden)', { timeout: 30000 });

  return { browser, page };
}

async function createProposal(page, title, type, options = '') {
  await page.selectOption('#proposal-type', type);
  await page.fill('#proposal-title', title);
  await page.fill('#proposal-description', `${type} proposal test`);
  if (options) {
    await page.fill('#proposal-options', options);
  }
  await page.click('#proposal-form button[type="submit"]');
  const card = page.locator(`.proposal-card:has(.proposal-card__title:text-is("${title}"))`).first();
  await card.waitFor({ state: 'visible' });
  return card.locator('.proposal-card__id').first().textContent();
}

async function getOptionTallies(page, proposalId) {
  const card = page.locator(`.proposal-card:has(.proposal-card__id:text-is("${proposalId}"))`).first();
  return card.locator('.vote-stat__value').allTextContents();
}

async function voteOption(page, proposalId, optionLabel) {
  const card = page.locator(`.proposal-card:has(.proposal-card__id:text-is("${proposalId}"))`).first();
  const btn = card.locator(`.vote-option:has-text("${optionLabel}")`).first();
  await btn.waitFor({ state: 'visible' });
  await btn.click({ force: true });
  await page.waitForTimeout(1500);
}

(async () => {
  const alice = await runUser('alice_e2e_' + Math.floor(Math.random() * 10000));
  const directId = await createProposal(alice.page, 'Multi-choice direct', 'direct', 'Alpha, Beta, Gamma');
  console.log('Created multi-choice direct proposal', directId);

  await voteOption(alice.page, directId, 'Beta');

  const bob = await runUser('bob_e2e_' + Math.floor(Math.random() * 10000));
  await voteOption(bob.page, directId, 'Alpha');

  const directTallies = await getOptionTallies(alice.page, directId);
  console.log('DIRECT TALLIES:', directTallies);
  if (JSON.stringify(directTallies) !== JSON.stringify(['1', '1', '0'])) {
    throw new Error(`Expected ['1','1','0'] on direct proposal, got ${JSON.stringify(directTallies)}`);
  }

  const qId = await createProposal(alice.page, 'Multi-choice quadratic', 'quadratic', 'Red, Green, Blue');
  console.log('Created multi-choice quadratic proposal', qId);

  for (let i = 0; i < 3; i++) {
    await voteOption(alice.page, qId, 'Red');
  }

  const qTallies = await getOptionTallies(alice.page, qId);
  console.log('QUADRATIC TALLIES:', qTallies);
  if (JSON.stringify(qTallies) !== JSON.stringify(['3', '0', '0'])) {
    throw new Error(`Expected ['3','0','0'] on quadratic proposal, got ${JSON.stringify(qTallies)}`);
  }

  await alice.browser.close();
  await bob.browser.close();
  console.log('Smoke test passed');
})();
```

- [ ] **Step 2: Rebuild everything and start a fresh server**

Run:

```bash
npm run build
lsof -ti:9000 | xargs -r kill -9 2>/dev/null || true
sleep 1
rm -rf data/wavedb/*
PORT=9000 node dist/server/src/index.js > /tmp/dao-server.log 2>&1 &
sleep 2
```

Expected: server listening on http://localhost:9000.

- [ ] **Step 3: Run the smoke test**

Run: `node test-voting-browser.js`
Expected: output ends with `Smoke test passed`, with `DIRECT TALLIES: [ '1', '1', '0' ]` and `QUADRATIC TALLIES: [ '3', '0', '0' ]`.

- [ ] **Step 4: Run the full unit suite**

Run: `npm run test:server`
Expected: all suites PASS.

- [ ] **Step 5: Stop the server and commit**

```bash
lsof -ti:9000 | xargs -r kill -9 2>/dev/null || true
git add test-voting-browser.js
git commit -m "test: smoke test multiple-choice voting flows"
```

---

## Self-Review

**Spec coverage:**
- Options in ProposalPayload, choice in VotePayload → Task 1 Step 1
- Option-count register + per-option sets/counters → Task 1 Step 5 (create handler)
- Unified vote handler (choice validation, no opposite-removal) → Task 1 Step 5
- Execute with strict majority + winner register (+1 encoding, noted) → Task 1 Step 5
- Binary-equivalence, tie, 5/3/3, unknown-choice, invalid-option tests → Task 1 Step 3
- `DaoNode.getProposalOptionVotes` → Task 2
- Client form input, parsing/validation, per-option buttons and tallies → Task 3
- Smoke test for both types with custom options → Task 4

**Placeholder scan:** No TBD/TODO; every code step shows complete code.

**Type consistency:** `choice: number` used in VotePayload, `onVote(proposalId, choice)`, and the vote handler; `options: string[]` used in ProposalPayload, create handler validation, `getProposalOptionVotes`, and the UI option rows; tallies helper names (`getOptionTallies`) match between Task 4 steps.