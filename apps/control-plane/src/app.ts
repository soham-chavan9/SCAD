import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { RuntimeProvider } from "@scad/runtime-conformance";
import type { Db } from "./db/client.js";
import { DeviceStore } from "./device-store.js";
import { errorHandler } from "./errors.js";
import { MachineController } from "./machines/controller.js";
import { authPlugin } from "./plugins/auth.js";
import { appsRoutes } from "./routes/apps.js";
import { authDeviceRoutes } from "./routes/auth-device.js";
import { healthRoutes } from "./routes/health.js";
import { internalBuildsRoutes } from "./routes/internal-builds.js";
import { internalRoutes } from "./routes/internal.js";
import { publishRoutes } from "./routes/publish.js";
import { releasesRoutes } from "./routes/releases.js";
import { shareRoutes } from "./routes/share.js";
import { createDataPaths, ensureDataDirs, type DataPaths } from "./storage.js";

export type BuildAppOptions = {
  db: Db["db"];
  /** Persist publish tarballs/logs. Defaults to SCAD_DATA_DIR or a temp dir. */
  dataDir?: string;
  baseDomain?: string;
  publicBaseUrl?: string;
  operatorEmails?: string[];
  /** Shared secret for builder job claim/complete (INTERNAL_TOKEN). */
  internalToken?: string;
  /** Shared secret for gateway → control-plane internal routes. */
  internalSecret?: string;
  devices?: DeviceStore;
  paths?: DataPaths;
  /** Runtime used to wake and idle-stop apps (T1.4). Wake routes 503 without it. */
  runtime?: RuntimeProvider;
  /** Pre-built controller (server.ts shares it with the idle stopper). */
  machines?: MachineController;
  /** Clock override (tests). */
  now?: () => Date;
};

export async function buildApp(opts: BuildAppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 105 * 1024 * 1024,
  });

  const dataDir =
    opts.dataDir ??
    process.env["SCAD_DATA_DIR"] ??
    mkdtempSync(join(tmpdir(), "scad-data-"));
  const paths = opts.paths ?? createDataPaths(dataDir);
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
  const internalToken = opts.internalToken ?? process.env["INTERNAL_TOKEN"];
  if (!internalToken) {
    throw new Error("INTERNAL_TOKEN is required");
  }

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
  await app.register(appsRoutes, { db: opts.db, baseDomain });
  await app.register(shareRoutes, { db: opts.db });
  await app.register(publishRoutes, { db: opts.db, paths, baseDomain });
  await app.register(releasesRoutes, { db: opts.db, paths });
  await app.register(internalBuildsRoutes, {
    db: opts.db,
    paths,
    internalToken,
  });

  const machines =
    opts.machines ??
    (opts.runtime
      ? new MachineController({
          db: opts.db,
          runtime: opts.runtime,
          ...(opts.now ? { now: opts.now } : {}),
        })
      : undefined);

  if (opts.internalSecret) {
    await app.register(internalRoutes, {
      db: opts.db,
      internalSecret: opts.internalSecret,
      baseDomain,
      ...(machines ? { machines } : {}),
    });
  }

  return app;
}

export type AppInstance = Awaited<ReturnType<typeof buildApp>>;
