#!/usr/bin/env bash
# Nightly-safe backup of what SCAD cannot rebuild (T3.1): Postgres, the keys
# in .env (MASTER_KEY, JWT keys), app /data volumes, and SCAD_DATA_DIR.
# Usage (repo root, on the server): bash deploy/backup.sh [out-dir]
# Copy the result OFF the server (docs/deploy.md, "Backups"). The archive
# holds every secret: keep it somewhere private, e.g. an encrypted disk.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/backups}/$(date +%F)"
COMPOSE=(docker compose -f "$ROOT/deploy/compose.yml" --env-file "$ROOT/.env")
data_dir="$(grep -E '^SCAD_DATA_DIR=' "$ROOT/.env" | cut -d= -f2- || true)"

umask 077
mkdir -p "$OUT"
"${COMPOSE[@]}" exec -T postgres pg_dump -U scad -Fc scad > "$OUT/scad.pgdump"
cp "$ROOT/.env" "$OUT/env"
for v in $(docker volume ls -q --filter label=scad.app_id); do
  docker run --rm -v "$v":/v:ro -v "$OUT":/out busybox:1.36 tar -C /v -czf "/out/$v.tgz" .
done
if [[ -n "$data_dir" && -d "$data_dir" ]]; then
  tar -C "$data_dir" -czf "$OUT/scad-data-dir.tgz" .
fi
echo "backup written to $OUT (contains secrets; copy it off this machine)"
