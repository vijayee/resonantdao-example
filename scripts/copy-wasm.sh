#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
CRABS_WASM="$ROOT/../CRABS/bindings/wasm"
EAUTH_WASM="$ROOT/../EAuth/bindings/wasm"
OUT="$ROOT/client/public/wasm"

mkdir -p "$OUT/crabs" "$OUT/eauth"

cp "$CRABS_WASM/crabs.js" "$CRABS_WASM/crabs.wasm" "$OUT/crabs/"
cp "$EAUTH_WASM/eauth.js" "$EAUTH_WASM/eauth.wasm" "$OUT/eauth/"

echo "WASM artifacts copied to $OUT"
