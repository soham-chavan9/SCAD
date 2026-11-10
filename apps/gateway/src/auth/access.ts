import { eq, sql } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import type { ResolvedApp } from "../resolve.js";
import type { GatewayUser } from "./users.js";

type Database = Db["db"];

/**
 * ACL (§9 step 5). Everything that can change after resolve is read fresh on
 * every request, not from the 30 s resolve cache: app status and expiry, the
 * owner's status (operator suspend, INV9: within 5 seconds), visibility, and
 * the allowlist (unshare, T1.2). The viewer's own status comes fresh from the
 * session lookup.
 */
export async function canViewApp(
  db: Database,
  app: ResolvedApp,
  user: GatewayUser,
  now = new Date(),
): Promise<boolean> {
  if (user.status !== "active") return false;

  const rows = await db
    .select({
      status: schema.apps.status,
      expiresAt: schema.apps.expiresAt,
      ownerId: schema.apps.ownerId,
      ownerStatus: schema.users.status,
      visibility: schema.apps.visibility,
      shared: sql<boolean>`exists (
        select 1 from ${schema.appAccess}
        where ${schema.appAccess.appId} = ${schema.apps.id}
          and ${schema.appAccess.email} = ${user.email.trim().toLowerCase()}
      )`,
    })
    .from(schema.apps)
    .innerJoin(schema.users, eq(schema.apps.ownerId, schema.users.id))
    .where(eq(schema.apps.id, app.appId))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (row.ownerStatus !== "active") return false;
  if (row.status === "suspended" || row.status === "expired" || row.status === "deleted") {
    return false;
  }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return false;
  if (row.ownerId === user.id) return true;
  return row.visibility === "instance" || row.shared === true;
}
