import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { makeError } from "@scad/shared";
import type { Db } from "@scad/control-plane";
import { canViewApp } from "../auth/access.js";
import { LoginCodeError, consumeLoginCode } from "../auth/login-codes.js";
import { createSession, loadSessionUser } from "../auth/sessions.js";
import type { GatewayUser } from "../auth/users.js";
import { SESSION_COOKIE, setSessionCookie } from "../cookies.js";
import { safeLocalReturnPath } from "../return-path.js";
import { authHost } from "../host.js";
import { buildUpstreamHeaders } from "../identity/headers.js";
import type { IdentityKeyMaterial } from "../identity/keys.js";
import {
  badCallbackPage,
  forbiddenPage,
  notFoundPage,
  wakingPage,
} from "../pages.js";
import type { AppResolver, ResolvedApp } from "../resolve.js";
import { upstreamTarget } from "../resolve.js";
import {
  HTML_HOLD_MS,
  WAKE_BUDGET_MS,
  isConnectFailure,
  isHtmlNavigation,
  type HoldOutcome,
  type WakeCoordinator,
} from "../wake.js";

export type AppHostOpts = {
  db: Db["db"];
  baseDomain: string;
  resolver: AppResolver;
  keys: IdentityKeyMaterial;
  /** Wake-on-request (T1.4). Without it, stopped apps are proxied as-is. */
  wake?: WakeCoordinator;
  wakeBudgetMs?: number;
  htmlHoldMs?: number;
};

/** 503 while the app starts: wait page for browsers, Retry-After for everything else. */
function sendWaking(request: FastifyRequest, reply: FastifyReply, outcome: HoldOutcome) {
  void reply.status(503).header("retry-after", "2").header("cache-control", "no-store");
  if (isHtmlNavigation(request)) {
    return reply.type("text/html").send(wakingPage(outcome === "failed"));
  }
  return reply.send(
    makeError(
      "INTERNAL",
      outcome === "failed" ? "The app could not be started" : "The app is starting",
      "Retry after the Retry-After interval.",
      {},
    ),
  );
}

function requestHost(request: FastifyRequest): string {
  return (request.headers.host ?? "").toLowerCase();
}

function loginRedirectUrl(baseDomain: string, request: FastifyRequest): string {
  const host = requestHost(request);
  const proto = baseDomain.startsWith("localhost") ? "http" : "https";
  const path = safeLocalReturnPath(request.url) ?? "/";
  const returnTo = `${proto}://${host}${path}`;
  const url = new URL(`${proto}://${authHost(baseDomain)}/login`);
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}

function issuerUrl(baseDomain: string): string {
  const proto = baseDomain.startsWith("localhost") ? "http" : "https";
  return `${proto}://${authHost(baseDomain)}`;
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

  if (!(await canViewApp(opts.db, resolved, user))) {
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

      const dest = safeLocalReturnPath(query.return_to);
      if (!dest) {
        return reply
          .status(400)
          .type("text/html")
          .send(badCallbackPage("Invalid return_to"));
      }
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

  /** Platform paths under /__scad/* never reach the app (callback handled above). */
  app.all("/__scad/*", async (_request, reply) => {
    return reply.status(404).type("text/html").send(notFoundPage());
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
    const wake = opts.wake;
    if (wake) {
      wake.touch(resolved.appId, user.id);
      if (wake.needsWake(resolved)) {
        const holdMs = isHtmlNavigation(request)
          ? (opts.htmlHoldMs ?? HTML_HOLD_MS)
          : (opts.wakeBudgetMs ?? WAKE_BUDGET_MS);
        const outcome = await wake.hold(wake.wake(resolved.appId, target), holdMs);
        if (outcome !== "ready") {
          return sendWaking(request, reply, outcome);
        }
      }
    }
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
      onError: (errReply, { error }) => {
        // Stale "running" status: the app was idle-stopped. Wake it; the body can't be replayed.
        if (wake && isConnectFailure(error)) {
          wake.markAsleep(resolved.appId);
          void wake.wake(resolved.appId, target).catch(() => undefined);
          return sendWaking(request, reply, "pending");
        }
        return errReply.send(error);
      },
    });
  });
};
