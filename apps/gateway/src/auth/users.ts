import { eq } from "drizzle-orm";
import { isHandle } from "@scad/shared";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import type { GithubProfile } from "./identity.js";
import { NotInvitedError } from "./signup.js";

type Database = Db["db"];

export type GatewayUser = {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  status: "active" | "suspended";
};

/** Derive a validated handle from GitHub login (lowercase). */
export function handleFromGithubLogin(login: string): string {
  const handle = login.toLowerCase();
  if (!isHandle(handle)) {
    throw new Error(`GitHub login cannot be used as handle: ${login}`);
  }
  return handle;
}

/**
 * Find or create the account for a GitHub sign-in. Existing accounts (by
 * GitHub id or email) always sign in; a new account is created only when
 * `mayCreate` allows the email (invite allowlist, T2.6), else NotInvitedError.
 */
export async function upsertGithubUser(
  db: Database,
  profile: GithubProfile,
  mayCreate: (email: string) => Promise<boolean> = async () => true,
): Promise<GatewayUser> {
  const handle = handleFromGithubLogin(profile.login);

  const byGithub = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.githubId, profile.githubId))
    .limit(1);

  const existing = byGithub[0];
  if (existing) {
    const [updated] = await db
      .update(schema.users)
      .set({
        email: profile.email,
        displayName: profile.name,
        handle,
      })
      .where(eq(schema.users.id, existing.id))
      .returning();
    if (!updated) throw new Error("failed to update user");
    return {
      id: updated.id,
      email: updated.email,
      handle: updated.handle,
      displayName: updated.displayName,
      status: updated.status,
    };
  }

  const byEmailFirst = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, profile.email))
    .limit(1);
  if (!byEmailFirst[0] && !(await mayCreate(profile.email))) {
    throw new NotInvitedError();
  }

  const byHandle = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.handle, handle))
    .limit(1);
  if (byHandle[0] && byHandle[0].githubId !== profile.githubId) {
    throw new Error(`Handle ${handle} is already taken`);
  }

  const byEmail = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, profile.email))
    .limit(1);
  if (byEmail[0]) {
    const [linked] = await db
      .update(schema.users)
      .set({
        githubId: profile.githubId,
        displayName: profile.name || byEmail[0].displayName,
        handle,
      })
      .where(eq(schema.users.id, byEmail[0].id))
      .returning();
    if (!linked) throw new Error("failed to link github user");
    return {
      id: linked.id,
      email: linked.email,
      handle: linked.handle,
      displayName: linked.displayName,
      status: linked.status,
    };
  }

  const [created] = await db
    .insert(schema.users)
    .values({
      email: profile.email,
      displayName: profile.name,
      githubId: profile.githubId,
      handle,
      role: "member",
      status: "active",
    })
    .returning();
  if (!created) throw new Error("failed to create user");
  return {
    id: created.id,
    email: created.email,
    handle: created.handle,
    displayName: created.displayName,
    status: created.status,
  };
}

/**
 * Candidate handle from an email local part: lowercase, runs of other
 * characters become one hyphen, trimmed to 39 chars (INV11: always validated).
 */
export function handleBaseFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return isHandle(cleaned) ? cleaned : "user";
}

/**
 * Create the account for someone signing in by email for the first time
 * (T1.2: an app was shared with them before they had one). Picks a free
 * handle `base`, `base-2`, `base-3`, ...
 */
export async function createEmailUser(db: Database, email: string): Promise<GatewayUser> {
  const base = handleBaseFromEmail(email);
  for (let n = 1; n <= 50; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (!isHandle(handle)) break;
    const [created] = await db
      .insert(schema.users)
      .values({ email, displayName: "", handle, role: "member", status: "active" })
      .onConflictDoNothing()
      .returning();
    if (created) {
      return {
        id: created.id,
        email: created.email,
        handle: created.handle,
        displayName: created.displayName,
        status: created.status,
      };
    }
    // Conflict: either the handle is taken, or the email was created concurrently.
    const [byEmail] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (byEmail) {
      return {
        id: byEmail.id,
        email: byEmail.email,
        handle: byEmail.handle,
        displayName: byEmail.displayName,
        status: byEmail.status,
      };
    }
  }
  throw new Error("could not allocate a handle");
}
