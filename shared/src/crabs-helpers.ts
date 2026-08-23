// Low-level helper for the crabs-wasm JS wrapper, which does not expose a
// public setter for an operation's signer_key_version. CRABS requires the
// version in the operation to match the user's current key_version when the
// operation is executed, so callers must set it before signing.
//
// This offset is derived from the WASM32 in-memory layout of operation_t and is
// localized here so it can be updated if the upstream wrapper ever exposes a
// real API.
export function setOperationSignerKeyVersion(op: any, version: number): void {
  const M = op._M;
  const ptr = op._ptr;
  if (!M || !ptr) return;
  const offset = 504;
  const addr = ptr + offset;
  const v = BigInt(version);
  for (let i = 0; i < 8; i++) {
    M.HEAPU8[addr + i] = Number((v >> BigInt(i * 8)) & BigInt(0xff));
  }
}
