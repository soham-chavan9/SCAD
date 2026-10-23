import { and, eq, gt, isNull } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import type { GatewayUser } from "./users.js";

type Database = Db["db"];

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(
  db: Database,
  opts: { userId: string; appHost: string; now?: Date },
): Promise<{ id: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const [row] = await db
    .insert(schema.sessions)
    .values({
      userId: opts.userId,
      appHost: opts.appHost.toLowerCase(),
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("failed to create session");
  return { id: row.id, expiresAt: row.expiresAt };
}

export async function loadSessionUser(
  db: Database,
  opts: { sessionId: string; appHost: string; now?: Date },
): Promise<GatewayUser | null> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      handle: schema.users.handle,
      displayName: schema.users.displayName,
      status: schema.users.status,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.sessions.id, opts.sessionId),
        eq(schema.sessions.appHost, opts.appHost.toLowerCase()),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
