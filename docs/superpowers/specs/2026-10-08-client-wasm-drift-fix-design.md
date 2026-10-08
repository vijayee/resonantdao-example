# Client Wasm Drift Fix (sync_roles key_stale) — Design

Date: 2026-10-08
Status: approved design, pending implementation plan
Depends on: all prior phases (implemented)

## Purpose

Fix the reproduced election bug: after a custodian election finalizes, the server-generated `sync_roles` op fails `Operation.deserialize` on the client, `applySyncRolesFromOp` never runs, and every later client-signed op is rejected `key_stale` — making elections effectively single-use in live demos.

## Root cause (empirically confirmed)

The client's vendored wasm binary is stale: `client/public/wasm/crabs/crabs.wasm` is a Sep-30 build emitting op wire-format **v4**; the server (node_modules symlink → CRABS/bindings/wasm) picked up an Oct-8 CRABS rebuild (wire **v5**, signing format v3, parent-attestation tail). The v4 client binary's `_crabs_wasm_deserialize_operation` returns 0 (null) on v5 bytes → `Operation.deserialize` throws (client/src/crabs-wasm-wrapper.ts:186). The skew is one-directional: client v4 bytes deserialize fine on the server glue, so only server-created ops (sync_roles — the only op the server authors) break clients. Not the wrapper's manual stamping: the key-version/HLC offsets are valid in both generations (verified by round-trip).

The drift mechanism: `node_modules/crabs-wasm` is a live symlink to the CRABS checkout (rebuilt upstream), while `client/public/wasm/crabs/` copies are static — `npm run copy-wasm` runs only on install/rebuild. CRABS upstream currently sits at b5dd4e4 (signing format v3); the copy step picks that up.

## Fix

1. **Sync the vendored binaries:** run `npm run copy-wasm` (`scripts/copy-wasm.sh`) so `client/public/wasm/crabs/` matches the current CRABS build; rebuild the client bundle. No wrapper-code changes — the TS wrapper's manual HLC/lamport/key-version stamping is redundant (current `crabs_wasm_sign_operation` stamps internally) but harmless.
2. **Regression guard (primary deliverable):** `server/test/crabs-wasm-format.test.ts` — node-only jest test that:
   - builds a server-side signed op via `DaoNode.createAdminOperation` (sync_roles payload, key version forced 1, real `node.sign`),
   - loads the CLIENT-vendored glue (`client/public/wasm/crabs/` via its `createCRABSModule` factory — works under node),
   - asserts `_crabs_wasm_deserialize_operation` (or the wrapper-level `Operation.deserialize`) succeeds on those bytes and that a client-serialized op round-trips on the server binary.
   Failure mode it catches: the exact wire drift that broke elections. Currently returns 0 → test FAILS; after the copy sync → PASSES. Run it as part of `npm test` (jest runs `server/test/*`).
3. **e2e:** the election section of `test-voting-browser.js` should now round-trip twice in a row; the KNOWN ISSUE log (script ~line 550) becomes unnecessary — update the log to verify-and-pass (keep a probe that the sync_roles apply succeeded rather than removing the check, so the guard stays in the e2e).

## Error handling / follow-ups

- If the copy step picks up breaking wrapper changes (new exports the TS wrapper lacks — the schedule family remains absent), the format test + a compile-level check pin what's needed; no schedule API is used by this app, so v3's wrapper deltas are out of scope here.
- The drift class is structural (symlink vs copy); the jest guard is the chosen mitigation (a postinstall hook also exists via `npm install`, not guaranteed in CI). If it recurs, revisit symlinking the vendored path instead of copying.

## Testing

- New jest test (above) — the fix's own acceptance test.
- Full suite green; e2e election section passes twice consecutively; client bundle rebuilt and the manual election demo verified (optional, low risk).