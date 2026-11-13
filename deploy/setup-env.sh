#!/usr/bin/env bash
# Write a production .env with fresh secrets (T3.1).
# Usage: bash deploy/setup-env.sh myscad.duckdns.org you@gmail.com
# Then add SMTP_URL (your Gmail app password) by hand. Never commit .env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
BASE="${1:-}"
EMAIL="${2:-}"

if [[ ! "$BASE" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ || "$BASE" != *.* || "$BASE" == *localhost* ]]; then
  echo "usage: bash deploy/setup-env.sh <your-name.duckdns.org> <you@example.com>" >&2
  exit 2
fi
if [[ ! "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "usage: bash deploy/setup-env.sh <your-name.duckdns.org> <you@example.com>" >&2
  exit 2
fi
if [[ -e "$ENV_FILE" ]]; then
  echo ".env already exists; leaving it alone (move it away to start over)" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
openssl genpkey -algorithm Ed25519 -out "$tmp/jwt.pem" 2>/dev/null
openssl pkey -in "$tmp/jwt.pem" -pubout -out "$tmp/jwt.pub" 2>/dev/null
# One line with literal \n: Compose and scripts/with-env.sh both keep it as-is.
oneline() { awk 'BEGIN{ORS="\\n"} {print}' "$1" | sed 's/\\n$//'; }

pg="$(openssl rand -hex 24)"
umask 077
BASE="$BASE" EMAIL="$EMAIL" PG="$pg" \
SECRET="$(openssl rand -hex 24)" TOKEN="$(openssl rand -hex 24)" MASTER="$(openssl rand -base64 32)" \
JWT_PRIV="$(oneline "$tmp/jwt.pem")" JWT_PUB="$(oneline "$tmp/jwt.pub")" awk '
  /^BASE_DOMAIN=/       { print "BASE_DOMAIN=" ENVIRON["BASE"]; next }
  /^ACME_EMAIL=/        { print "ACME_EMAIL=" ENVIRON["EMAIL"]; next }
  /^OPERATOR_EMAILS=/   { print "OPERATOR_EMAILS=" ENVIRON["EMAIL"]; next }
  /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" ENVIRON["PG"]; next }
  /^DATABASE_URL=/      { print "DATABASE_URL=postgres://scad:" ENVIRON["PG"] "@127.0.0.1:5432/scad"; next }
  /^INTERNAL_SECRET=/   { print "INTERNAL_SECRET=" ENVIRON["SECRET"]; next }
  /^INTERNAL_TOKEN=/    { print "INTERNAL_TOKEN=" ENVIRON["TOKEN"]; next }
  /^MASTER_KEY=/        { print "MASTER_KEY=" ENVIRON["MASTER"]; next }
  /^JWT_PRIVATE_KEY=/   { print "JWT_PRIVATE_KEY=" ENVIRON["JWT_PRIV"]; next }
  /^JWT_PUBLIC_KEY=/    { print "JWT_PUBLIC_KEY=" ENVIRON["JWT_PUB"]; next }
  { print }
' "${ROOT}/deploy/env.production.example" > "$ENV_FILE"

echo "wrote .env for ${BASE} (operator ${EMAIL}, mode 600)."
echo "Next: add SMTP_URL (Gmail app password) to .env, then follow docs/deploy.md."
