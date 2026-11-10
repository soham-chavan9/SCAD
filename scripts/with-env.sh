#!/usr/bin/env bash
# Run a command with .env loaded (T2.9). Values are parsed, never executed
# (scripts/load-dotenv.py), so a value with `$(...)` stays a literal string.
# Usage: bash scripts/with-env.sh pnpm --filter @scad/control-plane start
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "${ROOT}/.env" ]]; then
  echo ".env not found; run: bash scripts/setup-env.sh you@example.com" >&2
  exit 1
fi
eval "$(python3 "${ROOT}/scripts/load-dotenv.py" "${ROOT}/.env")"
exec "$@"
