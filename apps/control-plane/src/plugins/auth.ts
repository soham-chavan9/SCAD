import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pats, users } from "../db/schema.js";
import { extractBearerToken, hashPat } from "../auth/pat.js";
import { unauthenticated } from "../errors.js";

export type AuthUser = {
  id: string;
  email: string;
  handle: string;
  role: "operator" | "member";
  status: "active" | "suspended";
};

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }

  interface FastifyContextConfig {
    public?: boolean;
    /** Skip PAT auth; route enforces INTERNAL_SECRET itself. */
    internal?: boolean;
  }
}

export type AuthPluginOpts = {
  db: Db["db"];
};

async function resolveUser(request: FastifyRequest, db: Db["db"]): Promise<AuthUser> {
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    throw unauthenticated();
  }

  const tokenHash = hashPat(token);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      handle: users.handle,
      role: users.role,
      status: users.status,
      patId: pats.id,
    })
    .from(pats)
    .innerJoin(users, eq(pats.userId, users.id))
    .where(and(eq(pats.tokenHash, tokenHash), isNull(pats.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw unauthenticated("Invalid personal access token");
  }
  if (row.status !== "active") {
    throw unauthenticated("User account is not active");
  }

  await db.update(pats).set({ lastUsedAt: new Date() }).where(eq(pats.id, row.patId));

  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    role: row.role,
    status: row.status,
  };
}

const authPluginImpl: FastifyPluginAsync<AuthPluginOpts> = async (app, opts) => {
  app.decorateRequest("user", null as unknown as AuthUser);

  app.addHook("preHandler", async (request) => {
    const config = request.routeOptions.config;
    if (config.public || config.internal) {
      return;
    }
    request.user = await resolveUser(request, opts.db);
  });
};

/** Break Fastify encapsulation so PAT auth applies to all routes. */
export const authPlugin = fp(authPluginImpl, {
  name: "scad-pat-auth",
});
