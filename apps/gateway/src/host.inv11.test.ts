import { describe, expect, it } from "vitest";
import { parseHost } from "./host.js";

describe("parseHost INV11", () => {
  const base = "localhost:8080";

  it("accepts valid app host", () => {
    expect(parseHost("hello.alice.localhost:8080", base)).toEqual({
      kind: "app",
      slug: "hello",
      ownerHandle: "alice",
    });
  });

  it("lowercases Host then validates (HTTP Host is case-insensitive)", () => {
    expect(parseHost("HELLO.ALICE.localhost:8080", base)).toEqual({
      kind: "app",
      slug: "hello",
      ownerHandle: "alice",
    });
  });

  it.each([
    ["hel..lo.alice.localhost:8080", "empty slug segment"],
    ["hello.al ice.localhost:8080", "space in handle"],
    [`${"x".repeat(41)}.alice.localhost:8080`, "over-length slug"],
    ["hello;rm.alice.localhost:8080", "shell char in slug"],
    ["hello.аlice.localhost:8080", "unicode lookalike handle"],
    ["ab.alice.localhost:8080", "slug too short"],
  ])("rejects bad host %s (%s)", (host) => {
    expect(parseHost(host, base)).toEqual({ kind: "unknown" });
  });
});
