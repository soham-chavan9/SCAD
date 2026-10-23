import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, hashPat, issuePat } from "./index.js";

describe("@scad/control-plane", () => {
  it("exports package name and PAT helpers", () => {
    expect(PACKAGE_NAME).toBe("control-plane");
    const { token, tokenHash } = issuePat();
    expect(token.startsWith("scad_pat_")).toBe(true);
    expect(hashPat(token)).toBe(tokenHash);
  });
});
