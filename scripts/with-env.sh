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
# `pnpm --filter` runs each service in its own package directory, so anchor
# relative data paths at the repo root (the control plane and builder must
# agree on where uploads live).
if [[ -n "${SCAD_DATA_DIR:-}" && "${SCAD_DATA_DIR}" != /* ]]; then
  export SCAD_DATA_DIR="${ROOT}/${SCAD_DATA_DIR#./}"
fi
exec "$@"
