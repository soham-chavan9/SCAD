import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Db } from "@scad/control-plane";
import { LoginCodeError, consumeLoginCode } from "../auth/login-codes.js";
import { createSession, loadSessionUser } from "../auth/sessions.js";
import { SESSION_COOKIE, setSessionCookie } from "../cookies.js";
import { authHost } from "../host.js";
import {
  appReadyPage,
  badCallbackPage,
  forbiddenPage,
  notFoundPage,
} from "../pages.js";
import type { AppResolver, ResolvedApp } from "../resolve.js";

export type AppHostOpts = {
  db: Db["db"];
  baseDomain: string;
  resolver: AppResolver;
};

function requestHost(request: FastifyRequest): string {
  return (request.headers.host ?? "").toLowerCase();
}

function loginRedirectUrl(baseDomain: string, request: FastifyRequest): string {
  const host = requestHost(request);
  const proto = baseDomain.startsWith("localhost") ? "http" : "https";
  const returnTo = `${proto}://${host}${request.url}`;
  const url = new URL(`${proto}://${authHost(baseDomain)}/login`);
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}

function aclAllowsOwner(app: ResolvedApp, userId: string): boolean {
  if (app.ownerStatus !== "active") return false;
  if (app.status === "suspended" || app.status === "expired" || app.status === "deleted") {
    return false;
  }
  if (app.expiresAt && new Date(app.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  // T0.6: ACL = owner only
  return app.ownerId === userId;
}

export const appHostRoutes: FastifyPluginAsync<AppHostOpts> = async (app, opts) => {
  app.get("/__scad/callback", async (request, reply) => {
    const host = requestHost(request);
    const query = request.query as { code?: string; return_to?: string };
    if (!query.code) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing login code"));
    }

    try {
      const consumed = await consumeLoginCode(opts.db, {
        code: query.code,
        appHost: host,
      });
      const session = await createSession(opts.db, {
        userId: consumed.userId,
        appHost: host,
      });
      setSessionCookie(reply, session.id, opts.baseDomain, session.expiresAt);

      const dest = query.return_to && query.return_to.startsWith("/") ? query.return_to : "/";
      return reply.redirect(dest);
    } catch (err) {
      if (err instanceof LoginCodeError) {
        return reply
          .status(400)
          .type("text/html")
          .send(badCallbackPage(`Login code ${err.reason}`));
      }
      throw err;
    }
  });

  app.get("/*", async (request, reply) => {
    const host = requestHost(request);
    const resolved = await opts.resolver.resolve(host);
    if (!resolved) {
      return reply.status(404).type("text/html").send(notFoundPage());
    }

    const sessionId = request.cookies[SESSION_COOKIE];
    const user = sessionId
      ? await loadSessionUser(opts.db, { sessionId, appHost: host })
      : null;
    if (!user) {
      return reply.redirect(loginRedirectUrl(opts.baseDomain, request));
    }

    if (!aclAllowsOwner(resolved, user.id)) {
      return reply.status(403).type("text/html").send(forbiddenPage());
    }

    // Proxy lands in T0.7; for T0.6 show a ready page after ACL.
    return reply
      .status(200)
      .type("text/html")
      .send(appReadyPage(resolved.slug, resolved.ownerHandle));
  });
};
