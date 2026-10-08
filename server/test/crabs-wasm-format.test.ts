import { beforeAll, describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Cross-binary wire-format guard: a server-signed operation MUST deserialize
// on the client-vendored wasm, and client-serialized ops on the server build.
// When CRABS rebuilds (wire format drift), the vendored copies go stale —
// server ops stop deserializing client-side, sync_roles never applies, and
// every later client op dies key_stale (elections broke this way; see spec
// docs/superpowers/specs/2026-10-08-client-wasm-drift-fix-design.md).

const require_ = createRequire(__filename);
const CLIENT_WASM_DIR = join(__dirname, '..', '..', 'client', 'public', 'wasm', 'crabs');

jest.setTimeout(60000);

describe('cross-binary operation wire format', () => {
  let adminOpBytes: Uint8Array;
  let clientModule: any;

  beforeAll(async () => {
    // Server side: real DaoNode admin op (the exact op that broke elections).
    const { DaoNode } = await import('../src/crabs');
    const dao = new DaoNode();
    await dao.init();
    const op = await dao.createAdminOperation('sync_roles', {
      custodians: ['a'],
      roleVersions: { a: 4 },
    });
    adminOpBytes = op.serialize();

    // Client side: the vendored emscripten glue is a CommonJS module whose
    // exports are the module factory itself (module.exports = module.exports =
    // createCRABSModule, with .default also set). Calling it with no args
    // loads crabs.wasm from the same directory (locateFile uses __dirname).
    const factory = require_(join(CLIENT_WASM_DIR, 'crabs.js'));
    const createModule = typeof factory === 'function' ? factory : factory.default;
    expect(typeof createModule).toBe('function');
    clientModule = await createModule();
    expect(clientModule).toBeDefined();
    expect(typeof clientModule._crabs_wasm_deserialize_operation).toBe('function');
  });

  it('client-vendored wasm deserializes a server-signed admin op', () => {
    const bytes = new Uint8Array(adminOpBytes);
    const ptr = clientModule._malloc(bytes.length) as number;
    expect(ptr).toBeTruthy();
    clientModule.HEAPU8.set(bytes, ptr);
    // Returns the operation pointer; 0/null means the wire format was rejected.
    const opPtr = clientModule._crabs_wasm_deserialize_operation(ptr, bytes.length) as number;
    clientModule._free(ptr);
    expect(opPtr).toBeTruthy(); // previously: 0 = v4 binary rejects v5 bytes → elections broke
    clientModule._operation_destroy(opPtr);
  });

  it('server build still deserializes the same bytes (sanity, opposite direction)', async () => {
    const { Operation } = await import('crabs-wasm');
    const op = await Operation.deserialize(new Uint8Array(adminOpBytes));
    expect(op).toBeDefined();
  });
});