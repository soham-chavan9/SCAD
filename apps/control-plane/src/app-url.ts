import { isHandle, isSlug } from "@scad/shared";

/** Build the public app URL (AGENTS D9 / §6). INV11: slug/handle must already be validated. */
export function appUrl(opts: {
  slug: string;
  ownerHandle: string;
  baseDomain: string;
}): string {
  if (!isSlug(opts.slug) || !isHandle(opts.ownerHandle)) {
    throw new Error("appUrl requires a validated slug and owner handle (INV11)");
  }
  const host = `${opts.slug}.${opts.ownerHandle}.${opts.baseDomain}`;
  const hasScheme = /^https?:\/\//i.test(opts.baseDomain);
  if (hasScheme) {
    // Unusual — BASE_DOMAIN is host[:port]
    return `${opts.baseDomain.replace(/\/$/, "")}`;
  }
  const scheme = opts.baseDomain.includes("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}
