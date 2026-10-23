#!/usr/bin/env bash
# Rewrite JWT_PRIVATE_KEY / JWT_PUBLIC_KEY in .env as single-line \n-escaped PEMs.
# Prints only: "done" and the JWT_PRIVATE_KEY assignment line count. Never echoes key material.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
BACKUP="${ROOT}/.env.jwt-backup"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: .env not found" >&2
  exit 1
fi

cp "$ENV_FILE" "$BACKUP"

priv_pem="$(mktemp)"
pub_pem="$(mktemp)"
cleaned="$(mktemp)"
trap 'rm -f "$priv_pem" "$pub_pem" "$cleaned"' EXIT

openssl genpkey -algorithm ed25519 -out "$priv_pem" 2>/dev/null
openssl pkey -in "$priv_pem" -pubout -out "$pub_pem" 2>/dev/null

python3 - "$ENV_FILE" "$cleaned" "$priv_pem" "$pub_pem" <<'PY'
import sys
from pathlib import Path

env_path, out_path, priv_path, pub_path = sys.argv[1:5]


def escape_pem(raw: str) -> str:
    return raw.strip("\n").replace("\n", "\\n")


def is_assignment(line: str) -> bool:
    if not line or line.lstrip().startswith("#"):
        return False
    if "=" not in line:
        return False
    name, _sep, _rest = line.partition("=")
    return bool(name) and name[0].isalpha() and all(c.isalnum() or c == "_" for c in name)


def is_jwt_key_assignment(line: str) -> bool:
    return line.startswith("JWT_PRIVATE_KEY=") or line.startswith("JWT_PUBLIC_KEY=")


def assignment_complete(line: str) -> bool:
    _name, _sep, value = line.partition("=")
    if not value:
        return True
    if value.startswith('"'):
        i = 1
        while i < len(value):
            if value[i] == "\\" and i + 1 < len(value):
                i += 2
                continue
            if value[i] == '"':
                return True
            i += 1
        return False
    if value.startswith("'"):
        return len(value) > 1 and value.endswith("'")
    if "BEGIN" in value and "END" not in value:
        return False
    return True


def is_pem_continuation(line: str) -> bool:
    s = line.strip()
    if not s or s.startswith("#"):
        return False
    if s.startswith("-----"):
        return True
    if is_assignment(line):
        return False
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
    return len(s) >= 16 and all(c in allowed for c in s)


kept: list[str] = []
skipping = False

for line in Path(env_path).read_text().splitlines(keepends=True):
    raw = line.rstrip("\n\r")

    if is_jwt_key_assignment(raw):
        skipping = not assignment_complete(raw)
        continue

    if skipping:
        if is_pem_continuation(raw):
            continue
        # End of broken JWT block (blank or next real content).
        skipping = False
        if raw.strip() == "":
            continue

    kept.append(line if line.endswith("\n") else f"{line}\n")

while kept and kept[-1].strip() == "":
    kept.pop()
if kept and not kept[-1].endswith("\n"):
    kept[-1] += "\n"

priv_esc = escape_pem(Path(priv_path).read_text())
pub_esc = escape_pem(Path(pub_path).read_text())
kept.append("\n")
kept.append(f'JWT_PRIVATE_KEY="{priv_esc}"\n')
kept.append(f'JWT_PUBLIC_KEY="{pub_esc}"\n')
Path(out_path).write_text("".join(kept))
PY

mv "$cleaned" "$ENV_FILE"

line_count=$(
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text().splitlines()
count = 0
in_block = False
for line in lines:
    if line.startswith("JWT_PRIVATE_KEY="):
        in_block = True
        count = 1
        val = line.split("=", 1)[1]
        if val.startswith('"'):
            i = 1
            complete = False
            while i < len(val):
                if val[i] == "\\" and i + 1 < len(val):
                    i += 2
                    continue
                if val[i] == '"':
                    complete = True
                    break
                i += 1
            if complete:
                break
            continue
        if "BEGIN" in val and "END" not in val:
            continue
        break
    if in_block:
        count += 1
        name = line.split("=", 1)[0] if "=" in line else ""
        if name and name[0].isalpha() and all(c.isalnum() or c == "_" for c in name):
            count -= 1
            break
        if line.startswith("-----END"):
            break
print(count)
PY
)

echo "done"
echo "$line_count"
