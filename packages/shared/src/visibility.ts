/**
 * Who may open an app (T3.5). `allowlist` is "private" to founders and is the
 * default; `public` is anyone with the link. `instance` is every signed-in
 * user of this SCAD instance.
 */
export type AppVisibility = "allowlist" | "instance" | "public";

/** The words people use: private (default) or public. */
export type LinkKind = "private" | "public";

export function visibilityFor(kind: LinkKind): "allowlist" | "public" {
  return kind === "public" ? "public" : "allowlist";
}

/** One plain sentence saying what kind of link this is, for publish results. */
export function describeLink(visibility: AppVisibility): string {
  switch (visibility) {
    case "public":
      return "Public link: anyone with the link can open it, no sign-in. Search engines are asked not to list it.";
    case "instance":
      return "Instance link: anyone with an account on this SCAD can open it after signing in.";
    default:
      return "Private link: only people you share it with can open it (they confirm their email once).";
  }
}
