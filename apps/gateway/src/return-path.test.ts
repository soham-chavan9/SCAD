import { describe, expect, it } from "vitest";
import { safeLocalReturnPath } from "./return-path.js";

describe("safeLocalReturnPath", () => {
  it("allows ordinary paths", () => {
    expect(safeLocalReturnPath(undefined)).toBe("/");
    expect(safeLocalReturnPath("/")).toBe("/");
    expect(safeLocalReturnPath("/app?x=1")).toBe("/app?x=1");
  });

  it("rejects protocol-relative, backslash, and encoded-slash open redirects", () => {
    expect(safeLocalReturnPath("//evil.com")).toBeNull();
    expect(safeLocalReturnPath("/\\evil.com")).toBeNull();
    expect(safeLocalReturnPath("/%2f%2fevil.com")).toBeNull();
    expect(safeLocalReturnPath("https://evil.example/phish")).toBeNull();
  });

  it("rejects /\\evil.com, \\\\evil.com, https, javascript:, and %2f%2fevil.com", () => {
    expect(safeLocalReturnPath("/\\evil.com")).toBeNull();
    expect(safeLocalReturnPath("\\\\evil.com")).toBeNull();
    expect(safeLocalReturnPath("https://evil.com")).toBeNull();
    expect(safeLocalReturnPath("javascript:")).toBeNull();
    expect(safeLocalReturnPath("javascript:alert(1)")).toBeNull();
    expect(safeLocalReturnPath("%2f%2fevil.com")).toBeNull();
  });
});
