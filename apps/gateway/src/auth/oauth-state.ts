import { eq } from "drizzle-orm";
import { schema } from "@scad/control-plane";
import type { Db } from "@scad/control-plane";
import { randomToken } from "../crypto.js";
import * as oidc from "openid-client";

type Database = Db["db"];

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export async function createOauthState(
  db: Database,
  returnTo: string,
  now = new Date(),
): Promise<{ state: string; codeVerifier: string }> {
  const state = randomToken(24);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  await db.insert(schema.oauthStates).values({
    state,
    codeVerifier,
    returnTo,
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
  });
  return { state, codeVerifier };
}

export async function takeOauthState(
  db: Database,
  state: string,
  now = new Date(),
): Promise<{ codeVerifier: string; returnTo: string } | null> {
  const rows = await db
    .select()
    .from(schema.oauthStates)
    .where(eq(schema.oauthStates.state, state))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  await db.delete(schema.oauthStates).where(eq(schema.oauthStates.state, state));

  if (row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return { codeVerifier: row.codeVerifier, returnTo: row.returnTo };
}
