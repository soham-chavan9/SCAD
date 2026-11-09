/** AGENTS D8: apps expire 30 days after the last view, warn 7 days before, delete 14 days after. */
export const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPIRY_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** New `expires_at` after a view or publish, with the warning re-armed. */
export function renewedExpiry(now: Date): { expiresAt: Date; expiryWarnedAt: null } {
  return { expiresAt: new Date(now.getTime() + EXPIRY_MS), expiryWarnedAt: null };
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
