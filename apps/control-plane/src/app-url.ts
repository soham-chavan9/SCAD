import { formatAppUrl } from "@scad/shared";

/** Build the public app URL (AGENTS D9 / §6). INV11: slug/handle must already be validated. */
export function appUrl(opts: {
  slug: string;
  ownerHandle: string;
  baseDomain: string;
}): string {
  return formatAppUrl(opts);
}
