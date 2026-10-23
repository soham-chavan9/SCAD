import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { Db } from "./db/client.js";
import { DeviceStore } from "./device-store.js";
import { errorHandler } from "./errors.js";
import { authPlugin } from "./plugins/auth.js";
import { appsRoutes } from "./routes/apps.js";
import { authDeviceRoutes } from "./routes/auth-device.js";
import { healthRoutes } from "./routes/health.js";
import { internalBuildsRoutes } from "./routes/internal-builds.js";
import { publishRoutes } from "./routes/publish.js";
import { releasesRoutes } from "./routes/releases.js";
import { createDataPaths, ensureDataDirs, type DataPaths } from "./storage.js";

export type BuildAppOptions = {
  db: Db["db"];
  dataDir: string;
  baseDomain?: string;
  publicBaseUrl?: string;
  operatorEmails?: string[];
  internalToken?: string;
  devices?: DeviceStore;
  paths?: DataPaths;
};

export async function buildApp(opts: BuildAppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 105 * 1024 * 1024,
  });

  const paths = opts.paths ?? createDataPaths(opts.dataDir);
  await ensureDataDirs(paths);

  const devices = opts.devices ?? new DeviceStore();
  const baseDomain = opts.baseDomain ?? process.env["BASE_DOMAIN"] ?? "localhost:8080";
  const publicBaseUrl =
    opts.publicBaseUrl ?? process.env["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:4000";
  const operatorEmails = new Set(
    (opts.operatorEmails ?? (process.env["OPERATOR_EMAILS"] ?? "").split(","))
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const internalToken =
    opts.internalToken ?? process.env["INTERNAL_TOKEN"] ?? "dev-internal-token";

  app.setErrorHandler(errorHandler);

  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 1,
    },
  });

  await app.register(authPlugin, { db: opts.db });
  await app.register(healthRoutes);
  await app.register(authDeviceRoutes, {
    db: opts.db,
    devices,
    operatorEmails,
    publicBaseUrl,
  });
  await app.register(appsRoutes, { db: opts.db });
  await app.register(publishRoutes, { db: opts.db, paths, baseDomain });
  await app.register(releasesRoutes, { db: opts.db, paths });
  await app.register(internalBuildsRoutes, {
    db: opts.db,
    paths,
    internalToken,
  });

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
