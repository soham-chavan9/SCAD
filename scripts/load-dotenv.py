#!/usr/bin/env python3
"""Emit safe bash `export` lines for a dotenv file.

Does not execute values. A space after `=` is trimmed. Single-quoted values
stay literal (so `\\n` in a PEM stays two characters). Double-quoted values
honor `\\n` and `\\"`.
"""

from __future__ import annotations

import shlex
import sys
from pathlib import Path


def parse_dotenv(text: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, val = line.partition("=")
        name = name.strip()
        if name.startswith("export "):
            name = name[len("export ") :].strip()
        if not name or not name.replace("_", "").isalnum() or name[0].isdigit():
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            quote = val[0]
            val = val[1:-1]
            if quote == '"':
                val = val.replace(r"\n", "\n").replace(r"\"", '"').replace(r"\\", "\\")
        pairs.append((name, val))
    return pairs


def to_bash_exports(pairs: list[tuple[str, str]]) -> str:
    return "".join(f"export {name}={shlex.quote(val)}\n" for name, val in pairs)


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: load-dotenv.py FILE", file=sys.stderr)
        sys.exit(2)
    text = Path(sys.argv[1]).read_text()
    sys.stdout.write(to_bash_exports(parse_dotenv(text)))


if __name__ == "__main__":
    main()
