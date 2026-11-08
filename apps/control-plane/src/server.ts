import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { startLogRetention } from "./log-retention.js";
import { createDataPaths } from "./storage.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { MachineController, startIdleStopper } from "./machines/controller.js";
import { masterKeyRingFromEnv } from "./secrets/rotate.js";
import { RuntimeLogCollector, startRuntimeLogCollection } from "./logs/collector.js";
import { loadSecretValues } from "./secrets/env-store.js";

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const port = Number(process.env["PORT"] ?? 4000);
  // 0.0.0.0 so the gateway container can reach us via host.docker.internal
  const host = process.env["HOST"] ?? "0.0.0.0";

  await runMigrations(databaseUrl);
  const { db } = createDb(databaseUrl);

  // Throws on a malformed key; unset means env vars are unavailable (503).
  const masterKeys = masterKeyRingFromEnv(process.env);
  if (!masterKeys) {
    console.warn("MASTER_KEY is not set: `scad env` is disabled until it is.");
  }

  // Composition root: the only place the control plane picks a runtime driver.
  const runtime = new DockerRuntimeProvider();
  const logError = (what: string) => (err: unknown) =>
    console.error(`${what} failed:`, err instanceof Error ? err.message : err);
  // Runtime logs go into SCAD's own store (T1.7b); secret values are redacted first.
  const logCollector = new RuntimeLogCollector({
    db,
    runtime,
    ...(masterKeys ? { secretsFor: (appId: string) => loadSecretValues(db, masterKeys, appId) } : {}),
    onError: logError("runtime log collection"),
  });
  startRuntimeLogCollection(logCollector, { onError: logError("runtime log sweep") });
  const machines = new MachineController({
    db,
    runtime,
    onMachineRunning: (appId, providerId) => {
      logCollector.attach(appId, providerId).catch(logError("runtime log attach"));
    },
  });
  startIdleStopper(machines, { onError: logError("idle stopper") });

  const dataDir = process.env["SCAD_DATA_DIR"] ?? mkdtempSync(join(tmpdir(), "scad-data-"));
  const paths = createDataPaths(dataDir);
  startLogRetention(paths, { db, onError: logError("log retention") });

  const app = await buildApp({
    db,
    paths,
    machines,
    ...(masterKeys ? { masterKeys } : {}),
    ...(process.env["BASE_DOMAIN"] ? { baseDomain: process.env["BASE_DOMAIN"] } : {}),
    ...(process.env["PUBLIC_BASE_URL"] ? { publicBaseUrl: process.env["PUBLIC_BASE_URL"] } : {}),
    internalToken: required("INTERNAL_TOKEN"),
    ...(process.env["INTERNAL_SECRET"]
      ? { internalSecret: process.env["INTERNAL_SECRET"] }
      : {}),
  });

  await app.listen({ port, host });
  console.log(`control-plane listening on ${host}:${port}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
