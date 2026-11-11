import cookie from "@fastify/cookie";
import replyFrom from "@fastify/reply-from";
import Fastify from "fastify";
import type { Db } from "@scad/control-plane";
import type { IdentityProvider } from "./auth/identity.js";
import { authHost, parseHost } from "./host.js";
import type { IdentityKeyMaterial } from "./identity/keys.js";
import type { Mailer } from "./mail/mailer.js";
import { notFoundPage } from "./pages.js";
import { attachWebSocketProxy } from "./proxy/websocket.js";
import type { AppResolver } from "./resolve.js";
import { appHostRoutes } from "./routes/app-host.js";
import { authHostRoutes, type AuthHostOpts } from "./routes/auth-host.js";
import { WakeCoordinator, type MachineClient } from "./wake.js";

export type BuildGatewayOptions = {
  db: Db["db"];
  baseDomain: string;
  /** GitHub sign-in. `null` = not configured: only magic links are offered. */
  identity: IdentityProvider | null;
  resolver: AppResolver;
  keys: IdentityKeyMaterial;
  allowDevLogin?: boolean;
  /** Sends magic-link emails (T1.1). Required to offer email sign-in. */
  mailer: Mailer;
  /** Clock override (tests). */
  now?: () => Date;
  /** Control-plane wake/touch client (T1.4). Omit to proxy without waking. */
  machines?: MachineClient;
  /** Max hold for non-HTML requests while an app wakes (default 15 s, §14). */
  wakeBudgetMs?: number;
  /** Hold for HTML navigations before showing the wait page (default 3 s). */
  htmlHoldMs?: number;
  /** OPERATOR_EMAILS: may always create an account; everyone else needs an invite or a share (T2.6). */
  operatorEmails?: Iterable<string>;
  /** Anonymous requests per IP per minute to public sites (T3.5; default 300). */
  publicPerIpPerMinute?: number;
  /**
   * Reverse proxies in front of the gateway whose X-Forwarded-For to trust
   * (T3.1: Caddy). A comma list of IPs/CIDRs. Without it, every viewer
   * would share the proxy's IP in per-IP rate limits.
   */
  trustProxy?: string;
};

/**
 * Parse GATEWAY_TRUST_PROXY: a comma list of proxy IPs/CIDRs (deploy/ pins
 * Caddy's address). Unset or empty trusts nothing. Hop counts and `true` are
 * refused: they would let anyone who reaches the gateway pick their own IP.
 */
export function parseTrustProxy(value: string | undefined): string | undefined {
  const list = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0) return undefined;
  for (const entry of list) {
    if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(entry) || /^\d+$/.test(entry)) {
      throw new Error(`GATEWAY_TRUST_PROXY must list proxy IPs or CIDRs (got ${JSON.stringify(entry).slice(0, 60)})`);
    }
  }
  return list.join(",");
}

export async function buildGateway(opts: BuildGatewayOptions) {
  const app = Fastify({
    logger: false,
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
  });
  await app.register(cookie);
  await app.register(replyFrom);

  const authHostname = authHost(opts.baseDomain);
  const wake = opts.machines
    ? new WakeCoordinator({
        client: opts.machines,
        ...(opts.wakeBudgetMs !== undefined ? { readyTimeoutMs: opts.wakeBudgetMs } : {}),
      })
    : undefined;
  const wakeOpts = {
    ...(wake ? { wake } : {}),
    ...(opts.wakeBudgetMs !== undefined ? { wakeBudgetMs: opts.wakeBudgetMs } : {}),
    ...(opts.htmlHoldMs !== undefined ? { htmlHoldMs: opts.htmlHoldMs } : {}),
  };

  await app.register(
    async (scope) => {
      const authOpts: AuthHostOpts = {
        db: opts.db,
        baseDomain: opts.baseDomain,
        identity: opts.identity,
        keys: opts.keys,
        mailer: opts.mailer,
        now: opts.now ?? (() => new Date()),
        operatorEmails: new Set([...(opts.operatorEmails ?? [])].map((e) => e.trim().toLowerCase()).filter(Boolean)),
        ...(opts.allowDevLogin !== undefined ? { allowDevLogin: opts.allowDevLogin } : {}),
      };
      await scope.register(authHostRoutes, authOpts);
    },
    { constraints: { host: authHostname } },
  );

  await app.register(async (scope) => {
    scope.addHook("preHandler", async (request, reply) => {
      const parsed = parseHost(request.headers.host, opts.baseDomain);
      if (parsed.kind !== "app") {
        return reply.status(404).type("text/html").send(notFoundPage());
      }
    });
    await scope.register(appHostRoutes, {
      db: opts.db,
      baseDomain: opts.baseDomain,
      resolver: opts.resolver,
      keys: opts.keys,
      ...wakeOpts,
      ...(opts.publicPerIpPerMinute !== undefined ? { publicPerIpPerMinute: opts.publicPerIpPerMinute } : {}),
    });
  });

  attachWebSocketProxy(app.server, {
    db: opts.db,
    baseDomain: opts.baseDomain,
    resolver: opts.resolver,
    keys: opts.keys,
    ...wakeOpts,
  });

  return app;
}

export type GatewayInstance = Awaited<ReturnType<typeof buildGateway>>;
