import { describe, expect, it } from "vitest";
import { AppUrlError, assertFinalAppUrl, formatAppUrl } from "./app-url.js";

describe("formatAppUrl", () => {
  it("returns a real clickable localhost URL with no braces", () => {
    const url = formatAppUrl({
      slug: "hello-node",
      ownerHandle: "alice",
      baseDomain: "localhost:8080",
    });
    expect(url).toBe("http://hello-node.alice.localhost:8080");
    expect(url).not.toMatch(/[{}]/);
  });

  it("uses https when BASE_DOMAIN is not localhost", () => {
    const url = formatAppUrl({
      slug: "hello-node",
      ownerHandle: "alice",
      baseDomain: "apps.example.com",
    });
    expect(url).toBe("https://hello-node.alice.apps.example.com");
    expect(url).not.toMatch(/[{}]/);
  });

  it("fails with missing_host when BASE_DOMAIN is empty", () => {
    expect(() =>
      formatAppUrl({ slug: "hello-node", ownerHandle: "alice", baseDomain: "  " }),
    ).toThrow(AppUrlError);
    try {
      formatAppUrl({ slug: "hello-node", ownerHandle: "alice", baseDomain: "" });
    } catch (err) {
      expect(err).toBeInstanceOf(AppUrlError);
      expect((err as AppUrlError).reason).toBe("missing_host");
      expect((err as Error).message).not.toMatch(/\{slug\}|\{owner\}/);
    }
  });

  it("fails when owner handle is missing", () => {
    expect(() =>
      formatAppUrl({ slug: "hello-node", ownerHandle: "", baseDomain: "localhost:8080" }),
    ).toThrow(AppUrlError);
  });
});

describe("assertFinalAppUrl", () => {
  it("accepts concrete http URLs", () => {
    expect(assertFinalAppUrl("http://hello-node.alice.localhost:8080")).toBe(
      "http://hello-node.alice.localhost:8080",
    );
  });

  it("rejects template strings with braces", () => {
    expect(() => assertFinalAppUrl("http://{slug}.{owner}.localhost:8080")).toThrow(AppUrlError);
    try {
      assertFinalAppUrl("http://{slug}.{owner}.localhost:8080");
    } catch (err) {
      expect(err).toBeInstanceOf(AppUrlError);
      expect((err as AppUrlError).reason).toBe("template");
    }
  });

  it("rejects empty and non-http values", () => {
    expect(() => assertFinalAppUrl("")).toThrow(AppUrlError);
    expect(() => assertFinalAppUrl("not-a-url")).toThrow(AppUrlError);
    expect(() => assertFinalAppUrl("ftp://hello.alice.localhost:8080")).toThrow(AppUrlError);
  });
});
