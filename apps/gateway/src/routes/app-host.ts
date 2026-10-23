import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Db } from "@scad/control-plane";
import { LoginCodeError, consumeLoginCode } from "../auth/login-codes.js";
import { createSession, loadSessionUser } from "../auth/sessions.js";
import type { GatewayUser } from "../auth/users.js";
import { SESSION_COOKIE, setSessionCookie } from "../cookies.js";
import { authHost } from "../host.js";
import { buildUpstreamHeaders } from "../identity/headers.js";
import type { IdentityKeyMaterial } from "../identity/keys.js";
import {
  badCallbackPage,
  forbiddenPage,
  notFoundPage,
} from "../pages.js";
import type { AppResolver, ResolvedApp } from "../resolve.js";
import { upstreamTarget } from "../resolve.js";

export type AppHostOpts = {
  db: Db["db"];
  baseDomain: string;
  resolver: AppResolver;
  keys: IdentityKeyMaterial;
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

function issuerUrl(baseDomain: string): string {
  const proto = baseDomain.startsWith("localhost") ? "http" : "https";
  return `${proto}://${authHost(baseDomain)}`;
}

function aclAllowsOwner(app: ResolvedApp, userId: string): boolean {
  if (app.ownerStatus !== "active") return false;
  if (app.status === "suspended" || app.status === "expired" || app.status === "deleted") {
    return false;
  }
  if (app.expiresAt && new Date(app.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  return app.ownerId === userId;
}

async function requireAppSession(
  request: FastifyRequest,
  opts: AppHostOpts,
): Promise<{ resolved: ResolvedApp; user: GatewayUser } | { redirect: string } | { forbidden: true } | { notFound: true }> {
  const host = requestHost(request);
  const resolved = await opts.resolver.resolve(host);
  if (!resolved) {
    return { notFound: true };
  }

  const sessionId = request.cookies[SESSION_COOKIE];
  const user = sessionId
    ? await loadSessionUser(opts.db, { sessionId, appHost: host })
    : null;
  if (!user) {
    return { redirect: loginRedirectUrl(opts.baseDomain, request) };
  }

  if (!aclAllowsOwner(resolved, user.id)) {
    return { forbidden: true };
  }

  return { resolved, user };
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

  app.all("/*", async (request, reply) => {
    const gate = await requireAppSession(request, opts);
    if ("notFound" in gate) {
      return reply.status(404).type("text/html").send(notFoundPage());
    }
    if ("redirect" in gate) {
      return reply.redirect(gate.redirect);
    }
    if ("forbidden" in gate) {
      return reply.status(403).type("text/html").send(forbiddenPage());
    }

    const { resolved, user } = gate;
    const target = upstreamTarget(resolved);
    const identityHeaders = await buildUpstreamHeaders({
      incoming: request.headers,
      user,
      appId: resolved.appId,
      issuer: issuerUrl(opts.baseDomain),
      keys: opts.keys,
    });

    const dest = `http://${target.host}:${target.port}`;
    return reply.from(`${dest}${request.url}`, {
      rewriteRequestHeaders: () => identityHeaders,
    });
  });
};
