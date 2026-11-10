import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import { randomToken, sha256 } from "../crypto.js";
import type { GatewayUser } from "./users.js";

type Database = Db["db"];

export const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Active-or-suspended user with this email (case-insensitive), or null. */
export async function findUserByEmail(db: Database, email: string): Promise<GatewayUser | null> {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      handle: schema.users.handle,
      displayName: schema.users.displayName,
      status: schema.users.status,
    })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  return rows[0] ?? null;
}

/** Create a single-use link token. Only the SHA-256 hash is stored (INV5). */
export async function createMagicLink(
  db: Database,
  opts: { email: string; appHost: string; returnTo: string; now: Date },
): Promise<string> {
  const token = randomToken(32);
  await db.insert(schema.magicLinks).values({
    tokenHash: sha256(token),
    email: normalizeEmail(opts.email),
    appHost: opts.appHost.toLowerCase(),
    returnTo: opts.returnTo,
    createdAt: opts.now,
    expiresAt: new Date(opts.now.getTime() + MAGIC_LINK_TTL_MS),
  });
  return token;
}

export class MagicLinkError extends Error {
  readonly reason: "invalid" | "used" | "expired";

  constructor(reason: MagicLinkError["reason"]) {
    super(`magic link ${reason}`);
    this.name = "MagicLinkError";
    this.reason = reason;
  }
}

/** Atomically mark the link used. Fails if unknown, already used, or expired. */
export async function consumeMagicLink(
  db: Database,
  opts: { token: string; now: Date },
): Promise<{ email: string; appHost: string; returnTo: string }> {
  const tokenHash = sha256(opts.token);
  const [row] = await db
    .update(schema.magicLinks)
    .set({ usedAt: opts.now })
    .where(
      and(
        eq(schema.magicLinks.tokenHash, tokenHash),
        isNull(schema.magicLinks.usedAt),
        gt(schema.magicLinks.expiresAt, opts.now),
      ),
    )
    .returning();
  if (row) {
    return { email: row.email, appHost: row.appHost, returnTo: row.returnTo };
  }
  const [existing] = await db
    .select()
    .from(schema.magicLinks)
    .where(eq(schema.magicLinks.tokenHash, tokenHash))
    .limit(1);
  if (!existing) throw new MagicLinkError("invalid");
  if (existing.usedAt) throw new MagicLinkError("used");
  throw new MagicLinkError("expired");
}
