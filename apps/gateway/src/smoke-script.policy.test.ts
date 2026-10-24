import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("m0-smoke.sh fake-auth persistence", () => {
  it("does not rewrite GATEWAY_FAKE_AUTH into an existing env file", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const src = readFileSync(join(root, "scripts/m0-smoke.sh"), "utf8");
    expect(src).not.toContain('out.append("GATEWAY_FAKE_AUTH=1")');
    expect(src).toContain("export GATEWAY_FAKE_AUTH=1");
    expect(src).toContain('if [[ "$VM_ONLY" -ne 1 ]]; then');
  });
});
