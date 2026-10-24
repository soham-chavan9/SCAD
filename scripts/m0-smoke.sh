#!/usr/bin/env bash
# M0 exit smoke — browserless. Prints PASS/FAIL lines only; exit non-zero on any fail.
#
# Default path: no sudo / sysctl / iptables (works on macOS Docker Desktop).
# Optional: --vm-only enables Linux VM bridge/iptables tweaks and REFUSES on macOS.
#
# Why some Linux VMs need --vm-only:
#   Docker's bridge netfilter (bridge-nf-call-iptables=1) can send container↔container
#   traffic on internal networks through iptables FORWARD/DOCKER-USER. Combined with
#   drop policies, gateway↔app on scad-net-* fails even though Internal networks are
#   correctly configured. Setting bridge-nf-call-iptables=0 and adding a DOCKER-USER
#   ACCEPT for 172.16.0.0/12 restores ICC for smoke.
# Without those tweaks on affected Linux hosts, smoke checks 3/5/6 (identity headers,
# /__scad/*, login codes) FAIL because the gateway cannot reach the app. Isolation
# check 4 may still PASS (false sense of security if ICC is broken for everyone).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VM_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --vm-only) VM_ONLY=1 ;;
    -h|--help)
      echo "Usage: scripts/m0-smoke.sh [--vm-only]" >&2
      echo "  default   no sudo; macOS Docker Desktop safe" >&2
      echo "  --vm-only Linux only; may sudo sysctl/iptables for bridge ICC" >&2
      exit 0
      ;;
  esac
done

# Silence everything except PASS/FAIL on fd 3
exec 3>&1
exec 1>/tmp/m0-smoke-out.log
exec 2>/tmp/m0-smoke-err.log

pass() { echo "PASS: $1" >&3; }
fail() { echo "FAIL: $1" >&3; FAILED=1; }
FAILED=0
# Re-enable errexit for setup only; check_* must not abort the script.
set -e

SMOKE_EMAIL="${SMOKE_EMAIL:-smoke@example.com}"
SMOKE_DIR="${SMOKE_DIR:-$ROOT/.scad-smoke}"
CONFIG_PATH="$SMOKE_DIR/config.json"
COOKIE_JAR="$SMOKE_DIR/cookies.txt"
CP_PID=""
BUILDER_PID=""
CLEANUP_DONE=0

cleanup() {
  if [[ "$CLEANUP_DONE" -eq 1 ]]; then return; fi
  CLEANUP_DONE=1
  [[ -n "$CP_PID" ]] && kill "$CP_PID" 2>/dev/null || true
  [[ -n "$BUILDER_PID" ]] && kill "$BUILDER_PID" 2>/dev/null || true
  # Linux: kill leftover tsx servers by cwd. macOS has no /proc/<pid>/cwd.
  if [[ -d /proc ]]; then
    for pid in $(pgrep -f 'loader.mjs src/server.ts' 2>/dev/null || true); do
      cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
      case "$cwd" in
        */apps/control-plane|*/apps/builder) kill -9 "$pid" 2>/dev/null || true ;;
      esac
    done
  fi
  wait "$CP_PID" 2>/dev/null || true
  wait "$BUILDER_PID" 2>/dev/null || true
}
trap cleanup EXIT

load_dotenv() {
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
}

ensure_env() {
  if [[ ! -f "$ROOT/.env" ]]; then
    python3 - "$ROOT/.env.example" "$ROOT/.env" "$SMOKE_DIR" <<'PY'
import secrets, base64, sys
from pathlib import Path

example, out, smoke = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
vals = {
    "MASTER_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
    "INTERNAL_SECRET": secrets.token_hex(24),
    "INTERNAL_TOKEN": secrets.token_hex(24),
    "GATEWAY_FAKE_AUTH": "0",
    "GITHUB_CLIENT_ID": "",
    "GITHUB_CLIENT_SECRET": "",
    "OPERATOR_EMAILS": "",
    "SCAD_DATA_DIR": str(smoke / "data"),
    "SCAD_API_URL": "http://127.0.0.1:4000",
    "PUBLIC_BASE_URL": "http://127.0.0.1:4000",
    "CONTROL_PLANE_URL": "http://host.docker.internal:4000",
    "BASE_DOMAIN": "localhost:8080",
    "DATABASE_URL": "postgres://scad:scad@localhost:5432/scad",
    "SMTP_URL": "smtp://localhost:1025",
}
lines = []
seen = set()
for raw in example.read_text().splitlines():
    if not raw or raw.lstrip().startswith("#") or "=" not in raw:
        lines.append(raw)
        continue
    name, _, _ = raw.partition("=")
    if name in vals:
        lines.append(f"{name}={vals[name]}")
        seen.add(name)
    else:
        lines.append(raw)
for name, value in vals.items():
    if name not in seen:
        lines.append(f"{name}={value}")
out.write_text("\n".join(lines) + "\n")
PY
    bash "$ROOT/scripts/fix-env-jwt-key.sh" >/dev/null
  fi
  load_dotenv
  # Process-only. Do not write this into .env; a later real-auth restart must stay off.
  export GATEWAY_FAKE_AUTH=1
  if [[ -z "${OPERATOR_EMAILS//[[:space:]]/}" ]]; then
    export OPERATOR_EMAILS="$SMOKE_EMAIL"
  fi
}

wait_http() {
  local url="$1" tries="${2:-60}"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

host_of_url() {
  python3 -c 'import sys; from urllib.parse import urlparse; print(urlparse(sys.argv[1]).netloc)' "$1"
}

ensure_docker_icc() {
  # Only under --vm-only (Linux). Default path never uses sudo (macOS Docker Desktop).
  if [[ "$VM_ONLY" -ne 1 ]]; then
    return 0
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "FAIL: --vm-only refuses on macOS (no sudo/sysctl/iptables)" >&3
    exit 1
  fi
  # Bridge traffic must not be filtered by iptables or internal app nets break
  # (gateway↔app on scad-net-*). See net.bridge.bridge-nf-call-iptables.
  if [[ -w /proc/sys/net/bridge/bridge-nf-call-iptables ]]; then
    echo 0 | sudo tee /proc/sys/net/bridge/bridge-nf-call-iptables >/dev/null || true
    echo 0 | sudo tee /proc/sys/net/bridge/bridge-nf-call-ip6tables >/dev/null || true
  elif command -v sysctl >/dev/null 2>&1; then
    sudo sysctl -w net.bridge.bridge-nf-call-iptables=0 >/dev/null 2>&1 || true
    sudo sysctl -w net.bridge.bridge-nf-call-ip6tables=0 >/dev/null 2>&1 || true
  fi
  # Some Docker/nftables setups still drop bridge ICC; allow RFC1918 docker ranges.
  if command -v iptables >/dev/null 2>&1; then
    sudo iptables -C DOCKER-USER -s 172.16.0.0/12 -d 172.16.0.0/12 -j ACCEPT 2>/dev/null \
      || sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 172.16.0.0/12 -j ACCEPT 2>/dev/null \
      || true
  fi
}

start_stack() {
  mkdir -p "$SMOKE_DIR/data" "$SMOKE_DIR/logs"
  rm -f "$SMOKE_DIR/hello.url" "$SMOKE_DIR/hello.host" "$SMOKE_DIR/echo.url" "$SMOKE_DIR/echo.host" "$COOKIE_JAR"

  if [[ -d /proc ]]; then
    for pid in $(pgrep -f 'loader.mjs src/server.ts' 2>/dev/null || true); do
      cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
      case "$cwd" in
        */apps/control-plane|*/apps/builder) kill -9 "$pid" 2>/dev/null || true ;;
      esac
    done
  fi
  pkill -9 -f 'apps/control-plane' 2>/dev/null || true
  pkill -9 -f 'apps/builder' 2>/dev/null || true
  sleep 2

  ensure_docker_icc

  docker compose -f "$ROOT/docker-compose.yml" up -d postgres mailpit
  for i in $(seq 1 40); do
    if docker compose exec -T postgres pg_isready -U scad -d scad >/dev/null 2>&1; then break; fi
    sleep 1
  done

  docker compose -f "$ROOT/docker-compose.yml" up -d --build gateway

  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a

  : >"$SMOKE_DIR/logs/control-plane.log"
  : >"$SMOKE_DIR/logs/builder.log"

  pnpm --filter @scad/control-plane start >"$SMOKE_DIR/logs/control-plane.log" 2>&1 &
  CP_PID=$!

  if ! wait_http "http://127.0.0.1:4000/healthz" 90; then
    fail "setup (control-plane)"
    exit 1
  fi

  # Start builder only after CP is reachable (avoids claim storms on boot)
  pnpm --filter @scad/builder start >"$SMOKE_DIR/logs/builder.log" 2>&1 &
  BUILDER_PID=$!

  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: auth.localhost:8080" "http://127.0.0.1:8080/login" || true)
    if [[ "$code" != "000" && "$code" != "" ]]; then break; fi
    sleep 1
  done
}

scad() {
  SCAD_CONFIG="$CONFIG_PATH" SCAD_API_URL="${SCAD_API_URL:-http://127.0.0.1:4000}" \
    pnpm exec tsx "$ROOT/packages/cli/src/bin.ts" "$@"
}

issue_code() {
  local email="$1" host="$2"
  shift 2
  DATABASE_URL="${DATABASE_URL}" pnpm --filter @scad/gateway exec tsx \
    scripts/issue-login-code.ts --email "$email" --app-host "$host" "$@"
}

check_publish() {
  rm -f "$CONFIG_PATH"
  mkdir -p "$(dirname "$CONFIG_PATH")"

  if ! scad login --api-url "${SCAD_API_URL:-http://127.0.0.1:4000}" --approve-email "$SMOKE_EMAIL" >/tmp/m0-login.out 2>&1; then
    fail "1 publish hello-node"
    return
  fi

  # Unique slug per run avoids redeploy races with leftover containers
  local slug="hello-node-$$"
  if ! scad publish "$ROOT/examples/hello-node" --name "$slug" >/tmp/m0-publish-hello.out 2>&1; then
    fail "1 publish hello-node"
    return
  fi

  HELLO_URL="$(rg -o 'https?://[^[:space:]]+' /tmp/m0-publish-hello.out | tail -1 || true)"
  if [[ -z "$HELLO_URL" ]]; then
    fail "1 publish hello-node"
    return
  fi
  HELLO_HOST="$(host_of_url "$HELLO_URL")"
  echo "$HELLO_URL" >"$SMOKE_DIR/hello.url"
  echo "$HELLO_HOST" >"$SMOKE_DIR/hello.host"
  pass "1 publish hello-node"
}

curl_app() {
  # Prefer 127.0.0.1 + Host to avoid *.localhost IPv6 (::1) quirks
  local host="$1"
  shift
  curl -sS -H "Host: ${host}" "http://127.0.0.1:8080${1:-/}" "${@:2}"
}

check_unauth_redirect() {
  local host
  host="$(cat "$SMOKE_DIR/hello.host" 2>/dev/null || true)"
  if [[ -z "$host" ]]; then
    fail "2 unauth redirects to auth.localhost"
    return
  fi
  local loc
  loc="$(curl -sS -o /dev/null -D - -H "Host: ${host}" "http://127.0.0.1:8080/" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2; exit}')"
  if [[ "$loc" == *"auth.localhost"* ]]; then
    pass "2 unauth redirects to auth.localhost"
  else
    fail "2 unauth redirects to auth.localhost"
  fi
}

check_forged_identity() {
  local slug="echo-identity-$$"
  if ! scad publish "$ROOT/examples/echo-identity" --name "$slug" >/tmp/m0-publish-echo.out 2>&1; then
    fail "3 forged X-SCAD identity ignored"
    return
  fi
  local url host code body email
  url="$(rg -o 'https?://[^[:space:]]+' /tmp/m0-publish-echo.out | tail -1 || true)"
  if [[ -z "$url" ]]; then
    fail "3 forged X-SCAD identity ignored"
    return
  fi
  host="$(host_of_url "$url")"
  echo "$url" >"$SMOKE_DIR/echo.url"
  echo "$host" >"$SMOKE_DIR/echo.host"

  code="$(issue_code "$SMOKE_EMAIL" "$host" 2>/tmp/m0-issue-code.err || true)"
  code="$(echo "$code" | tr -d '[:space:]')"
  if [[ -z "$code" ]]; then
    fail "3 forged X-SCAD identity ignored"
    return
  fi

  rm -f "$COOKIE_JAR"
  curl -sS -c "$COOKIE_JAR" -o /dev/null \
    -H "Host: ${host}" \
    "http://127.0.0.1:8080/__scad/callback?code=${code}&return_to=/"

  body="$(curl -sS -b "$COOKIE_JAR" \
    -H "Host: ${host}" \
    -H "X-SCAD-User-Email: forged@evil.test" \
    -H "x-scad-user-email: also-forged@evil.test" \
    -H "X-SCAD-User-Email: duplicate@evil.test" \
    "http://127.0.0.1:8080/")"

  email="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("email") or "")' <<<"$body" 2>/dev/null || true)"
  if [[ "$email" == "$SMOKE_EMAIL" ]]; then
    pass "3 forged X-SCAD identity ignored"
  else
    fail "3 forged X-SCAD identity ignored"
  fi
}

check_isolation() {
  local host app_id container ip other published
  host="$(cat "$SMOKE_DIR/hello.host" 2>/dev/null || true)"
  if [[ -z "$host" ]]; then
    fail "4 app isolation (host + cross-net)"
    return
  fi

  local resolve_json
  resolve_json="$(curl -sS -X POST "http://127.0.0.1:4000/internal/resolve" \
    -H "content-type: application/json" \
    -H "x-scad-internal-secret: ${INTERNAL_SECRET}" \
    -d "{\"host\":\"${host}\"}" || true)"
  app_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("appId",""))' <<<"$resolve_json" 2>/dev/null || true)"
  if [[ -z "$app_id" ]]; then
    fail "4 app isolation (host + cross-net)"
    return
  fi
  container="scad-run-${app_id}"
  ip="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}' "$container" 2>/dev/null || true)"
  # Host exposure = published ports (bridge IP reachability is a Docker host quirk)
  published="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$container" 2>/dev/null || true)"

  local host_ok=0 cross_ok=0
  if [[ -n "$published" && "$published" != "null" && "$published" != "{}" ]]; then
    # Any HostPort binding means reachable from host via published port
    if ! echo "$published" | rg -q '"HostPort":"[0-9]+"'; then
      host_ok=1
    fi
  else
    host_ok=1
  fi

  if [[ -n "$ip" ]]; then
    docker pull -q busybox:1.36 >/dev/null 2>&1 || docker pull busybox:1.36 >/dev/null
    other="scad-smoke-probe-net-$$"
    docker network create --internal "$other" >/dev/null
    if ! docker run --rm --network "$other" busybox:1.36 \
      wget -T 3 -q -O - "http://${ip}:8080/" >/dev/null 2>&1; then
      cross_ok=1
    fi
    docker network rm "$other" >/dev/null 2>&1 || true
  fi

  if [[ "$host_ok" -eq 1 && "$cross_ok" -eq 1 ]]; then
    pass "4 app isolation (host + cross-net)"
  else
    fail "4 app isolation (host + cross-net)"
  fi
}

check_scad_paths() {
  local host body code
  host="$(cat "$SMOKE_DIR/echo.host" 2>/dev/null || true)"
  if [[ -z "$host" || ! -f "$COOKIE_JAR" ]]; then
    fail "5 /__scad/* never reaches app"
    return
  fi
  body="$(curl -sS -b "$COOKIE_JAR" -H "Host: ${host}" \
    "http://127.0.0.1:8080/__scad/should-not-proxy" || true)"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -H "Host: ${host}" \
    "http://127.0.0.1:8080/__scad/should-not-proxy" || true)"
  if [[ "$code" == "404" ]] && ! echo "$body" | rg -q '"email"'; then
    pass "5 /__scad/* never reaches app"
  else
    fail "5 /__scad/* never reaches app"
  fi
}

check_login_codes() {
  local host code status1 status2 exp_code exp_status
  host="$(cat "$SMOKE_DIR/echo.host" 2>/dev/null || true)"
  if [[ -z "$host" ]]; then
    fail "6 reused/expired login code rejected"
    return
  fi

  code="$(issue_code "$SMOKE_EMAIL" "$host" || true)"
  if [[ -z "$code" ]]; then
    fail "6 reused/expired login code rejected"
    return
  fi
  status1="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Host: ${host}" \
    "http://127.0.0.1:8080/__scad/callback?code=${code}&return_to=/")"
  status2="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Host: ${host}" \
    "http://127.0.0.1:8080/__scad/callback?code=${code}&return_to=/")"

  exp_code="$(issue_code "$SMOKE_EMAIL" "$host" --expire || true)"
  exp_status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Host: ${host}" \
    "http://127.0.0.1:8080/__scad/callback?code=${exp_code}&return_to=/" || true)"

  if [[ "$status1" == "302" && "$status2" == "400" && "$exp_status" == "400" ]]; then
    pass "6 reused/expired login code rejected"
  else
    fail "6 reused/expired login code rejected"
  fi
}

check_return_to() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Host: auth.localhost:8080" \
    "http://127.0.0.1:8080/login?return_to=https://evil.example/phish")"
  if [[ "$code" == "400" ]]; then
    pass "7 return_to rejects outside BASE_DOMAIN"
  else
    fail "7 return_to rejects outside BASE_DOMAIN"
  fi
}

ensure_env
start_stack

# Checks: never abort the suite on a single curl/assert failure
set +e
check_publish
check_unauth_redirect
check_forged_identity
check_isolation
check_scad_paths
check_login_codes
check_return_to
set -e

exit "$FAILED"
