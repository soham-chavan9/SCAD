import { describe, expect, it } from "vitest";
import { applyManifestDefaults, describeManifestIssues, parseManifest } from "./manifest.js";

describe("manifest schema", () => {
  it("accepts a valid full manifest", () => {
    const result = parseManifest({
      name: "sprint-tracker",
      port: 3000,
      start: "node server.js",
      env: { NODE_ENV: "production" },
      egress: ["api.github.com"],
      resources: { memory_mb: 512, disk_gb: 1 },
      frame_ancestors: "self",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("sprint-tracker");
      expect(result.data.port).toBe(3000);
    }
  });

  it("accepts an empty object (all fields optional)", () => {
    const result = parseManifest({});
    expect(result.success).toBe(true);
  });

  it("rejects a bad slug in name", () => {
    const result = parseManifest({ name: "Bad_Slug!" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("name"))).toBe(true);
    }
  });

  it("rejects memory over cap", () => {
    const result = parseManifest({ resources: { memory_mb: 2048 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.path.includes("resources") || i.path.includes("memory_mb"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a bad port", () => {
    for (const port of [0, -1, 65536, 1.5]) {
      const result = parseManifest({ port });
      expect(result.success, `port ${port} should fail`).toBe(false);
    }
  });

  it("applies defaults from §11", () => {
    const defaults = applyManifestDefaults({});
    expect(defaults.port).toBe(8080);
    expect(defaults.resources.memory_mb).toBe(512);
    expect(defaults.resources.disk_gb).toBe(1);
    expect(defaults.frame_ancestors).toBe("self");
  });
});

describe("manifest field-level errors (T1.5)", () => {
  it("rejects env keys that are not valid variable names", () => {
    for (const key of ["1ABC", "A-B", "A=B", "", "A B"]) {
      const result = parseManifest({ env: { [key]: "x" } });
      expect(result.success, `env key ${JSON.stringify(key)} should fail`).toBe(false);
    }
    expect(parseManifest({ env: { NODE_ENV: "production", _X1: "y" } }).success).toBe(true);
  });

  it("names the offending field in the hint", () => {
    const result = parseManifest({ resources: { memory_mb: 4096 } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const { hint, issues } = describeManifestIssues(result.error);
    expect(issues[0]).toMatchObject({ path: "resources.memory_mb" });
    expect(hint).toContain("resources.memory_mb");
    expect(hint).toContain("1024");
  });

  it("names unknown keys in the hint", () => {
    const result = parseManifest({ prot: 3000 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const { hint } = describeManifestIssues(result.error);
    expect(hint).toContain("prot");
  });
});
