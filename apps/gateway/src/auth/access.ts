import { and, eq, sql } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import type { ResolvedApp } from "../resolve.js";
import type { GatewayUser } from "./users.js";

type Database = Db["db"];

/**
 * ACL (§9 step 5). App status comes from the resolve cache; visibility and
 * the allowlist are read fresh on every request so unshare and visibility
 * changes apply immediately (T1.2: within 5 seconds).
 */
export async function canViewApp(
  db: Database,
  app: ResolvedApp,
  user: GatewayUser,
  now = new Date(),
): Promise<boolean> {
  if (user.status !== "active") return false;
  if (app.ownerStatus !== "active") return false;
  if (app.status === "suspended" || app.status === "expired" || app.status === "deleted") {
    return false;
  }
  if (app.expiresAt && new Date(app.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  if (app.ownerId === user.id) return true;

  const rows = await db
    .select({
      visibility: schema.apps.visibility,
      shared: sql<boolean>`exists (
        select 1 from ${schema.appAccess}
        where ${schema.appAccess.appId} = ${schema.apps.id}
          and ${schema.appAccess.email} = ${user.email.trim().toLowerCase()}
      )`,
    })
    .from(schema.apps)
    .where(and(eq(schema.apps.id, app.appId)))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  return row.visibility === "instance" || row.shared === true;
}
