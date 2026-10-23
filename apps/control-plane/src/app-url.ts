/** Build the public app URL (AGENTS D9 / §6). */
export function appUrl(opts: {
  slug: string;
  ownerHandle: string;
  baseDomain: string;
}): string {
  const host = `${opts.slug}.${opts.ownerHandle}.${opts.baseDomain}`;
  const hasScheme = /^https?:\/\//i.test(opts.baseDomain);
  if (hasScheme) {
    // Unusual — BASE_DOMAIN is host[:port]
    return `${opts.baseDomain.replace(/\/$/, "")}`;
  }
  const scheme = opts.baseDomain.includes("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}
