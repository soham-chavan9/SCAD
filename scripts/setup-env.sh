#!/usr/bin/env bash
# Create .env for local development from .env.example (T2.9).
# Usage: bash scripts/setup-env.sh you@example.com
# Fills OPERATOR_EMAILS with your email and generates INTERNAL_SECRET,
# INTERNAL_TOKEN, and MASTER_KEY. Never overwrites an existing .env and never
# prints the generated values.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
EMAIL="${1:-}"

if [[ -z "$EMAIL" || "$EMAIL" != *@* ]]; then
  echo "usage: bash scripts/setup-env.sh you@example.com" >&2
  exit 2
fi
if [[ -e "$ENV_FILE" ]]; then
  echo ".env already exists; leaving it alone (delete it to start over)" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

secret="$(openssl rand -hex 24)"
token="$(openssl rand -hex 24)"
master="$(openssl rand -base64 32)"

umask 077
EMAIL="$EMAIL" SECRET="$secret" TOKEN="$token" MASTER="$master" awk '
  /^OPERATOR_EMAILS=/ { print "OPERATOR_EMAILS=" ENVIRON["EMAIL"]; next }
  /^INTERNAL_SECRET=/ { print "INTERNAL_SECRET=" ENVIRON["SECRET"]; next }
  /^INTERNAL_TOKEN=/  { print "INTERNAL_TOKEN=" ENVIRON["TOKEN"]; next }
  /^MASTER_KEY=/      { print "MASTER_KEY=" ENVIRON["MASTER"]; next }
  { print }
' "${ROOT}/.env.example" > "$ENV_FILE"

echo "wrote .env (operator: ${EMAIL}; secrets generated, mode 600). Back up MASTER_KEY: it decrypts app secrets."
