import { eq } from "drizzle-orm";
import { isHandle } from "@scad/shared";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import type { GithubProfile } from "./identity.js";

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

export async function upsertGithubUser(
  db: Database,
  profile: GithubProfile,
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
