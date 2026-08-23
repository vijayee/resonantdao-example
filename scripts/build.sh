#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run build:server
npm run build:client
