import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type { Db } from "@scad/control-plane";
import type { IdentityProvider } from "./auth/identity.js";
import { authHost, parseHost } from "./host.js";
import { notFoundPage } from "./pages.js";
import type { AppResolver } from "./resolve.js";
import { appHostRoutes } from "./routes/app-host.js";
import { authHostRoutes, type AuthHostOpts } from "./routes/auth-host.js";

export type BuildGatewayOptions = {
  db: Db["db"];
  baseDomain: string;
  identity: IdentityProvider;
  resolver: AppResolver;
  allowDevLogin?: boolean;
};

export async function buildGateway(opts: BuildGatewayOptions) {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  const authHostname = authHost(opts.baseDomain);

  // Auth host only (Fastify host constraint).
  await app.register(
    async (scope) => {
      const authOpts: AuthHostOpts = {
        db: opts.db,
        baseDomain: opts.baseDomain,
        identity: opts.identity,
        ...(opts.allowDevLogin !== undefined ? { allowDevLogin: opts.allowDevLogin } : {}),
      };
      await scope.register(authHostRoutes, authOpts);
    },
    { constraints: { host: authHostname } },
  );

  // App hosts: reject auth host so /login is not shadowed.
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
    });
  });

  return app;
}

export type GatewayInstance = Awaited<ReturnType<typeof buildGateway>>;
