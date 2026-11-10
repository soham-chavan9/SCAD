import { describe, expect, it } from "vitest";
import { buildFailedHint } from "./build-hint.js";

describe("BUILD_FAILED hint (T1.8)", () => {
  it.each([
    "wget: bad address 'registry.npmjs.org'",
    "npm error code EAI_AGAIN",
    "npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org",
    "ERROR: Could not find a version that satisfies the requirement flask (from versions: none)",
    "pip._vendor.urllib3: Temporary failure in name resolution",
    "curl: (6) Could not resolve host: example.com",
    "fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main: network unreachable",
  ])("explains --network=none when the log shows a download failed: %s", (line) => {
    const hint = buildFailedHint(["#7 [3/5] RUN something", line]);
    expect(hint).toMatch(/no network/i);
    expect(hint).toMatch(/vendor/i);
  });

  it("points at log_tail otherwise", () => {
    const hint = buildFailedHint(["#5 ERROR: failed to solve: process \"/bin/sh -c false\" did not complete"]);
    expect(hint).not.toMatch(/no network/i);
    expect(hint).toMatch(/log_tail/);
  });
});
