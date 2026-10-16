#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
CRABS_WASM="$ROOT/../CRABS/bindings/wasm"
CRABS_DEVTOOLS="$ROOT/../CRABS/bindings/devtools"
EAUTH_WASM="$ROOT/../EAuth/bindings/wasm"
OUT="$ROOT/client/public/wasm"
DEV_OUT="$ROOT/client/dev-wasm"

mkdir -p "$OUT/crabs" "$OUT/eauth" "$DEV_OUT"

# Production artifacts ship to public/ (copied into dist/ by vite build).
cp "$CRABS_WASM/crabs.js" "$CRABS_WASM/crabs.wasm" "$OUT/crabs/"
cp "$EAUTH_WASM/eauth.js" "$EAUTH_WASM/eauth.wasm" "$OUT/eauth/"

# Devtools artifacts live OUTSIDE public/ so a production release cannot
# include them: the dev server serves client/dev-wasm/* at /dev-wasm/*.
cp "$CRABS_WASM/crabs.dev.js" "$CRABS_WASM/crabs.dev.wasm" "$DEV_OUT/"
cp "$CRABS_DEVTOOLS/devtools-api.js" "$CRABS_DEVTOOLS/crabs-devtools.js" "$DEV_OUT/"

echo "WASM artifacts copied to $OUT (prod) and $DEV_OUT (devtools)"
