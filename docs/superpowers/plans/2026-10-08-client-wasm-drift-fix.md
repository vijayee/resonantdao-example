# Client-Wasm Drift Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the election-breaking client wasm drift (v4 binary vs v5 server ops) and add a cross-binary format guard so CRABS rebuilds can't silently break the client again.

**Architecture:** The vendor copies (`client/public/wasm/crabs/`) refresh from the live CRABS checkout via the existing `scripts/copy-wasm.sh`; a node-only jest test proves the SERVER-signed ops deserialize on the CLIENT-vendored binary (and vice versa) — currently failing (wire v4 vs v5), passing after the sync. e2e keeps an assert on the sync_roles apply rather than merely logging the KNOWN ISSUE.

**Tech Stack:** TypeScript, crabs-wasm (CRABS), Jest, Playwright e2e.

---

## Baseline

- HEAD: phase-3 complete (8 suites / 129 tests green). Root cause pinned empirically (spec 2026-10-08): client/public/wasm/crabs/crabs.wasm = Sep-30 build (wire v4, `_crabs_wasm_deserialize_operation` returns 0 on v5 bytes); node_modules/crabs-wasm = live symlink, Oct-8 build (wire v5, signing format v3 @ CRABS b5dd4e4). The repro (server-signed op → client-binary deserialize) is proven node-side.
- The client glue (`client/public/wasm/crabs/crabs.js`) is loadable under node via its module factory (emscripten glue — call the factory; the research repro did).
- `scripts/copy-wasm.sh` copies `CRABS/bindings/wasm/{crabs.js,crabs.wasm}` (+ eauth) into `client/public/wasm/`.

### Task 1: Cross-binary format guard + vendored-binary sync

**Files:**
- Create: `server/test/crabs-wasm-format.test.ts`
- Modify: `client/public/wasm/crabs/crabs.js` + `crabs.wasm` (via the copy script — NOT edited by hand)
- Optional: `client/dist/wasm/crabs/*` (rebuilt via `npm run build:client`)

- [ ] **Step 1: Write the failing test** — create `server/test/crabs-wasm-format.test.ts`:

```typescript
import { beforeAll, afterAll, describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Cross-binary wire-format guard: a server-signed operation MUST deserialize
// on the client-vendored wasm, and client-serialized ops on the server build.
// When CRABS rebuilds (wire format drift), the vendored copies go stale —
// server ops stop deserializing client-side, sync_roles never applies, and
// every later client op dies key_stale (elections broke this way; see spec
// docs/superpowers/specs/2026-10-08-client-wasm-drift-fix-design.md).

const require_ = createRequire(import.meta.url ?? __filename);
const CLIENT_WASM_DIR = join(__dirname, '..', '..', 'client', 'public', 'wasm', 'crabs');

jest.setTimeout(60000);

describe('cross-binary operation wire format', () => {
  let serverModule: any;
  let clientModule: any;
  let adminOpBytes: Buffer;

  beforeAll(async () => {
    // Server side: real DaoNode admin op (the exact op that broke elections).
    const { DaoNode } = await import('../../server/src/crabs');
    const { buildServerSignedAdminOpBytes } = await import('./crabs-op-fixtures'); // see note
    adminOpBytes = buildServerSignedAdminOpBytes();

    // Client side: vendored emscripten glue under node.
    const factory = require_(join(CLIENT_WASM_DIR, 'crabs.js'));
    clientModule = await (factory.default ?? factory)().then((m: any) => m instanceof Object && m.calledRun !== undefined ? m : (m as any));
    // NOTE: resolve the exact factory invocation convention empirically when
    // writing this test — call the module factory with no args; if it returns
    // a promise of a module object, use that; if a global factory (like
    // createCRABSModule) is exported, use it. The /tmp repro proved node-side
    // loading works; pin the exact call shape in this test file.
  });

  afterAll(() => { try { clientModule?._crabs_wasm_destroy?.(); } catch { /* noop */ } });

  it('client-vendored wasm deserializes a server-signed admin op', () => {
    const bytes = new Uint8Array(adminOpBytes);
    const ptr = clientModule._malloc_bytes(bytes.length) ?? allocate(clientModule, bytes);
    (pin the exact allocation helper used in the repro — malloc + HEAPU8.set)
    const result = clientModule._crabs_wasm_deserialize_operation(ptr, bytes.length);
    expect(result).not.toBe(0); // previously: 0 = v4 binary rejects v5 bytes → elections broke
  });

  it('server build still deserializes the same bytes (sanity, opposite direction)', async () => {
    const op = await serverModule.Operation.deserialize(new Uint8Array(adminOpBytes));
    expect(op).toBeDefined();
  });
});
```

**NOTE (implementer):** the raw-wasm call shape above is guidance — the proven repro lives at `/tmp/crabsbug/repro2.cjs` from the root-cause investigation (session may not persist it); recreate the small repro FIRST inside this test using whatever the CURRENT client glue exports (read `client/public/wasm/crabs/crabs.js` exports; the wrapper `client/src/crabs-wasm-wrapper.ts` shows the exact symbol/factory conventions, incl. `_crabs_wasm_deserialize_operation(ptr, len)` allocation via `module._malloc` + `HEAPU8.set`). If the factory convention is uncertain, mirror `client/src/wasm.ts` `loadCRABS` — its import path may point at `/wasm/crabs/index.js`; for node tests, adapt to a direct require of the vendored `crabs.js` factory. Whatever loads the module is fine as long as BOTH binaries in the test are the vendored-client and the server-node_modules pair.

The op fixture: instead of an import helper file, build it inline in `beforeAll` — replicate `DaoNode.createAdminOperation`:

```typescript
    const { DaoNode } = await import('../../server/src/crabs');
    const dao = new DaoNode();
    await dao.init();
    const op = await (dao as any).createAdminOperation('sync_roles', { custodians: ['a'], roleVersions: { a: 4 } });
    adminOpBytes = Buffer.from(await opBytes(op)); // op.serialize() → Uint8Array
```

(Adapt: `createAdminOperation` returns `Promise<Operation>`; serialize via `op.serialize()`; destroy after.)

- [ ] **Step 2: Run** `npm test -- crabs-wasm-format.test.ts` → **FAIL** (client binary returns 0 — this is the pinned bug).
- [ ] **Step 3: Sync the vendored binaries:**

```bash
npm run copy-wasm
```

Expected: `client/public/wasm/crabs/crabs.js|crabs.wasm` updated from `../CRABS/bindings/wasm` (verify with `sha256sum client/public/wasm/crabs/crabs.wasm ../CRABS/bindings/wasm/crabs.wasm` — equal).
- [ ] **Step 4: Run test again → PASS; full `npm test` → all green (9 suites).** `npm run build:client` — pass (rebundled wasm).
- [ ] **Step 5: Commit**

```bash
git add server/test/crabs-wasm-format.test.ts client/public/wasm/crabs/crabs.js client/public/wasm/crabs/crabs.wasm
git commit -m "fix: re-sync vendored client wasm (wire v5) + cross-binary format guard"
```

### Task 2: e2e double-election proof + docs

**Files:**
- Modify: `test-voting-browser.js` (~line 550 area, KNOWN ISSUE block)
- Modify: `docs/contribution-economy/README.md` (binding paragraph)

- [ ] **Step 1: e2e — replace the KNOWN ISSUE degradation** with an assertion: after the first election finalize + sync_roles apply, the client's next signed op is ACCEPTED (alice files a new proposal successfully after election churn); then run or repeat a second election cycle if the script's flow allows a compact repeat (or at minimum assert `op_accepted` follows the post-election proposal — proving keyVersion catch-up worked). Follow the script's existing conventions (dialog arming, click retry). Note in the header comment the fresh-DB requirement plus that this asserts the wire-drift fix.
- [ ] **Step 2: Run the e2e** (dev server + `WAVEDB_PATH=/tmp/dao-wasmfix-fresh`): expect full pass incl. the post-election proposal; report honestly (previously failing path, now passing).
- [ ] **Step 3: Docs** — extend `docs/contribution-economy/README.md`'s binding section:

```markdown
- Fix (2026-10-08): client-wasm wire-drift — elections broke because the
  vendored client binary (wire v4) couldn't deserialize server ops (wire v5,
  sync_roles); `npm run copy-wasm` re-syncs and the cross-binary format guard
  (`server/test/crabs-wasm-format.test.ts`) fails fast when CRABS rebuilds
  drift the formats again.
```

- [ ] **Step 4: Commit**

```bash
git add test-voting-browser.js docs/contribution-economy/README.md
git commit -m "test/docs: assert post-election ops flow; record the wasm-drift fix"
```

---

## Self-review

- **Spec coverage:** copy sync (Task 1 Step 3), jest guard both directions (Task 1), client rebuild (Task 1 Step 4), e2e double-check + KNOWN ISSUE → assert (Task 2), docs (Task 2 Step 3). The spec's error-handling/follow-ups (schedule-API absence note, symlink-vs-copy revisit) stay out of scope — documented in the spec, referenced only.
- **Placeholder scan:** the test skeleton marks two empirically-resolved spots (module factory call shape, allocation helper) with explicit implementer notes + pointers to the proven conventions — those are empiricism instructions, not TBDs: the test CANNOT be authored blind (emscripten call ABI), and the plan tells the implementer exactly where to get the truth (wrapper + wasm.ts + repro conventions).
- **Type consistency:** op fixture built via the real `DaoNode.createAdminOperation('sync_roles', SyncRolesPayload-shaped)` — matches the server's actual op; client assertion via `_crabs_wasm_deserialize_operation` as named in the root-cause report; round-trip assertion via the server module's own `Operation.deserialize`.