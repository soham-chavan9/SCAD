import { describe, expect, it } from "vitest";
import { buildFailureEnvelope } from "./builder.js";

describe("buildFailureEnvelope (T3.2)", () => {
  it("names packages whose install scripts SCAD skipped, so the agent can swap them", () => {
    const env = buildFailureEnvelope({ ok: false, log: "Error: Cannot find module 'bcrypt'", message: "docker build failed" }, ["bcrypt", "esbuild"]);
    expect(env.code).toBe("BUILD_FAILED");
    expect(env.hint).toContain("bcrypt, esbuild");
    expect(env.hint).toMatch(/install scripts/);
    expect(env.details).toMatchObject({ skipped_install_scripts: ["bcrypt", "esbuild"] });
  });

  it("leaves the hint alone when nothing was skipped", () => {
    const env = buildFailureEnvelope({ ok: false, log: "x", message: "docker build failed" });
    expect(env.hint).not.toMatch(/install scripts/);
  });
});
