import { createHash, randomBytes } from "node:crypto";

const PAT_PREFIX = "scad_pat_";

/** Hash a PAT for storage. Tokens are never stored plaintext (AGENTS §7). */
export function hashPat(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Issue a new PAT plaintext + its hash. Caller stores only the hash. */
export function issuePat(): { token: string; tokenHash: string } {
  const token = `${PAT_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: hashPat(token) };
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}
