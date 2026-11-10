import { createRuntimeProvider } from "@scad/runtime-factory";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { startLogRetention } from "./log-retention.js";
import { createDataPaths } from "./storage.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { MachineController, startIdleStopper, startVolumeQuotaSweep } from "./machines/controller.js";
import { masterKeyRingFromEnv } from "./secrets/rotate.js";
import { LifecycleJobs, startLifecycleJobs } from "./lifecycle/jobs.js";
import { defaultFromAddress, LogMailer, SmtpMailer } from "./lifecycle/mailer.js";
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

  // The driver comes from SCAD_RUNTIME (default docker) via the provider-neutral
  // factory; the control plane never imports a provider package itself.
  const runtime = createRuntimeProvider();
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
  // T1.3 measured quota: stop running apps whose /data grew past its limit.
  startVolumeQuotaSweep(machines, { onError: logError("volume quota sweep") });

  // T2.5: expiry warnings, expiry, grace-period deletion, orphan reaper, usage roll-up.
  const baseDomain = process.env["BASE_DOMAIN"] ?? "localhost:8080";
  const smtpUrl = process.env["SMTP_URL"];
  const lifecycle = new LifecycleJobs({
    db,
    machines,
    ...(runtime.listApps ? { inventory: { listApps: () => runtime.listApps!() } } : {}),
    baseDomain,
    mailer: smtpUrl
      ? new SmtpMailer({ smtpUrl, from: process.env["SMTP_FROM"] ?? defaultFromAddress(baseDomain) })
      : new LogMailer(),
  });
  startLifecycleJobs(lifecycle, {
    onError: (job, err) => logError(job)(err),
    onReap: (report) =>
      console.warn(
        `orphan reaper: ${report.orphans.length} runtime app(s) with no DB row, ${report.missing.length} machine(s) missing in the runtime`,
      ),
  });

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
