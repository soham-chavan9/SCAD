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
};

export async function buildGateway(opts: BuildGatewayOptions) {
  const app = Fastify({ logger: false });
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
