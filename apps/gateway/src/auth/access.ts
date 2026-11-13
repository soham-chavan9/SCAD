import { eq, sql } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import type { ResolvedApp } from "../resolve.js";
import type { GatewayUser } from "./users.js";

type Database = Db["db"];

/** What the gateway does with a request for an app (§9 step 5, T3.5). */
export type AccessDecision =
  /** Serve it. `isPublic`: anyone with the link may see it (no sign-in needed). */
  | { kind: "allow"; isPublic: boolean }
  /** No viewer and the site is private: send them to sign in. */
  | { kind: "sign_in" }
  /** Signed in but not allowed, or the site is switched off. */
  | { kind: "forbidden" };

/**
 * ACL (§9 step 5). Everything that can change after resolve is read fresh on
 * every request, not from the 30 s resolve cache: app status and expiry, the
 * owner's status (operator suspend, INV9: within 5 seconds), visibility
 * (public → private takes effect on the next request), and the allowlist
 * (unshare, T1.2). The viewer's own status comes fresh from the session lookup.
 *
 * `user` is null for a visitor with no valid session. A public site lets them
 * in; a private one asks them to sign in first (before revealing anything
 * about the app's state). A suspended, expired, or deleted site is never
 * served, public or not.
 */
export async function decideAccess(
  db: Database,
  app: ResolvedApp,
  user: GatewayUser | null,
  now = new Date(),
): Promise<AccessDecision> {
  const email = user?.email.trim().toLowerCase() ?? "";
  const rows = await db
    .select({
      status: schema.apps.status,
      expiresAt: schema.apps.expiresAt,
      ownerId: schema.apps.ownerId,
      ownerStatus: schema.users.status,
      visibility: schema.apps.visibility,
      shared: user
        ? sql<boolean>`exists (
            select 1 from ${schema.appAccess}
            where ${schema.appAccess.appId} = ${schema.apps.id}
              and ${schema.appAccess.email} = ${email}
          )`
        : sql<boolean>`false`,
    })
    .from(schema.apps)
    .innerJoin(schema.users, eq(schema.apps.ownerId, schema.users.id))
    .where(eq(schema.apps.id, app.appId))
    .limit(1);
  const row = rows[0];
  const switchedOff =
    !row ||
    row.ownerStatus !== "active" ||
    row.status === "suspended" ||
    row.status === "expired" ||
    row.status === "deleted" ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime());

  if (!user) {
    if (row?.visibility === "public") {
      return switchedOff ? { kind: "forbidden" } : { kind: "allow", isPublic: true };
    }
    return { kind: "sign_in" };
  }
  if (user.status !== "active" || switchedOff || !row) return { kind: "forbidden" };
  if (row.visibility === "public") return { kind: "allow", isPublic: true };
  if (row.ownerId === user.id || row.visibility === "instance" || row.shared === true) {
    return { kind: "allow", isPublic: false };
  }
  return { kind: "forbidden" };
}

/** True when this signed-in user may view the app now (HTTP and WebSocket re-checks). */
export async function canViewApp(
  db: Database,
  app: ResolvedApp,
  user: GatewayUser,
  now = new Date(),
): Promise<boolean> {
  return (await decideAccess(db, app, user, now)).kind === "allow";
}
