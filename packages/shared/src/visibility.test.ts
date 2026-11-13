import { describe, expect, it } from "vitest";
import { describeLink, visibilityFor } from "./visibility.js";

describe("link kinds (T3.5)", () => {
  it("maps private to the allowlist and public to public", () => {
    expect(visibilityFor("private")).toBe("allowlist");
    expect(visibilityFor("public")).toBe("public");
  });

  it("says plainly which kind of link it is", () => {
    expect(describeLink("allowlist")).toMatch(/^Private link: only people you share it with/);
    expect(describeLink("public")).toMatch(/^Public link: anyone with the link.*no sign-in/);
    expect(describeLink("public")).toMatch(/Search engines/);
  });
});
