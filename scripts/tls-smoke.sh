#!/usr/bin/env bash
# Local proof of the T3.1 TLS front: deploy/Caddyfile with Caddy's internal CA
# in place of Let's Encrypt, asking the real control-plane ask endpoint.
# Checks: a live app host and the API host get a certificate, an unknown host
# gets none, /internal/* is not reachable through the API host.
# Usage: DATABASE_URL=postgres://... bash scripts/tls-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="scad.test"
CP_PORT="${TLS_SMOKE_CP_PORT:-4100}"
TLS_PORT="${TLS_SMOKE_PORT:-8443}"
NAME="scad-tls-smoke-$$"
: "${DATABASE_URL:?DATABASE_URL is required}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [[ -n "${cp_pid:-}" ]] && kill "$cp_pid" 2>/dev/null || true
}
trap cleanup EXIT

BASE_DOMAIN="$BASE" TLS_SMOKE_CP_PORT="$CP_PORT" npx tsx "$ROOT/apps/control-plane/scripts/tls-smoke-cp.ts" &
cp_pid=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$CP_PORT/healthz" >/dev/null && break; sleep 0.5; done

docker run -d --name "$NAME" -p "127.0.0.1:$TLS_PORT:443" \
  --add-host host.docker.internal:host-gateway \
  -e BASE_DOMAIN="$BASE" -e ACME_EMAIL=smoke@example.com -e CADDY_ISSUER=internal \
  -e TLS_ASK_URL="http://host.docker.internal:$CP_PORT/internal/tls-ask" \
  -e CONTROL_PLANE_UPSTREAM="host.docker.internal:$CP_PORT" \
  -v "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10.2-alpine >/dev/null
sleep 3

fail=0
handshake() { # host [path] -> prints the HTTP status, or "no-cert" when TLS fails
  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 \
    --resolve "$1:$TLS_PORT:127.0.0.1" "https://$1:$TLS_PORT${2:-/}" 2>/dev/null || true)"
  if [[ -z "$code" || "$code" == "000" ]]; then echo "no-cert"; else echo "$code"; fi
}
check() { # label, got, want-regex
  if [[ "$2" =~ $3 ]]; then echo "PASS $1 ($2)"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi
}

check "live app host gets a certificate" "$(handshake "hello-static.tlssmoke.$BASE")" '^[0-9]{3}$'
check "api host gets a certificate and reaches the control plane" "$(handshake "api.$BASE" /healthz)" '^200$'
check "api host does not expose /internal" "$(handshake "api.$BASE" "/internal/tls-ask?domain=api.$BASE")" '^404$'
check "auth host gets a certificate" "$(handshake "auth.$BASE")" '^[0-9]{3}$'
check "unknown app host gets no certificate" "$(handshake "nope-site.tlssmoke.$BASE")" '^no-cert$'
check "foreign host gets no certificate" "$(handshake "evil.example.com")" '^no-cert$'

exit "$fail"
