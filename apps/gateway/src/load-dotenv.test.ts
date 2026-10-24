import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("load-dotenv.py", () => {
  it("trims a space after = and does not execute the value", () => {
    const dir = mkdtempSync(join(tmpdir(), "scad-dotenv-"));
    const file = join(dir, "env");
    const marker = join(dir, "pwned");
    writeFileSync(
      file,
      [
        "OPERATOR_EMAILS= person@example.com",
        `EVIL=$(touch ${marker})`,
        "JWT_PRIVATE_KEY='line1\\nline2'",
        "",
      ].join("\n"),
    );

    let sourceStatus = 0;
    try {
      execFileSync("bash", ["-c", 'set -e; source "$1"', "bash", file], { encoding: "utf8" });
    } catch (err) {
      sourceStatus = (err as { status?: number }).status ?? 0;
    }
    expect(sourceStatus).toBe(127);

    const loaded = execFileSync(
      "bash",
      [
        "-c",
        'eval "$(python3 "$1" "$2")"; printf %s "$OPERATOR_EMAILS"; printf "\\n%s" "$JWT_PRIVATE_KEY"',
        "bash",
        "scripts/load-dotenv.py",
        file,
      ],
      { encoding: "utf8", cwd: join(import.meta.dirname, "../../..") },
    );
    expect(loaded.startsWith("person@example.com\n")).toBe(true);
    expect(loaded).toContain("line1\\nline2");
    expect(execFileSync("bash", ["-c", `test ! -e ${marker}`], { encoding: "utf8" })).toBe("");
  });
});
