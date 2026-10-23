import Fastify from "fastify";
import type { Db } from "./db/client.js";
import { errorHandler } from "./errors.js";
import { authPlugin } from "./plugins/auth.js";
import { appsRoutes } from "./routes/apps.js";
import { healthRoutes } from "./routes/health.js";
import { internalRoutes } from "./routes/internal.js";

export type BuildAppOptions = {
  db: Db["db"];
  internalSecret?: string;
  baseDomain?: string;
};

export async function buildApp(opts: BuildAppOptions) {
  const app = Fastify({
    logger: false,
  });

  app.setErrorHandler(errorHandler);

  await app.register(authPlugin, { db: opts.db });
  await app.register(healthRoutes);
  await app.register(appsRoutes, { db: opts.db });

  if (opts.internalSecret) {
    await app.register(internalRoutes, {
      db: opts.db,
      internalSecret: opts.internalSecret,
      baseDomain: opts.baseDomain ?? "localhost:8080",
    });
  }

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
