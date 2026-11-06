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

export type BuildGatewayOptions = {
  db: Db["db"];
  baseDomain: string;
  identity: IdentityProvider;
  resolver: AppResolver;
  keys: IdentityKeyMaterial;
  allowDevLogin?: boolean;
  /** Sends magic-link emails (T1.1). Required to offer email sign-in. */
  mailer: Mailer;
  /** Clock override (tests). */
  now?: () => Date;
};

export async function buildGateway(opts: BuildGatewayOptions) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(replyFrom);

  const authHostname = authHost(opts.baseDomain);

  await app.register(
    async (scope) => {
      const authOpts: AuthHostOpts = {
        db: opts.db,
        baseDomain: opts.baseDomain,
        identity: opts.identity,
        keys: opts.keys,
        mailer: opts.mailer,
        now: opts.now ?? (() => new Date()),
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
    });
  });

  attachWebSocketProxy(app.server, {
    db: opts.db,
    baseDomain: opts.baseDomain,
    resolver: opts.resolver,
    keys: opts.keys,
  });

  return app;
}

export type GatewayInstance = Awaited<ReturnType<typeof buildGateway>>;
