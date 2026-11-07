import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { MachineController, startIdleStopper } from "./machines/controller.js";
import { masterKeyRingFromEnv } from "./secrets/rotate.js";

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const port = Number(process.env["PORT"] ?? 4000);
  // 0.0.0.0 so the gateway container can reach us via host.docker.internal
  const host = process.env["HOST"] ?? "0.0.0.0";

  await runMigrations(databaseUrl);
  const { db } = createDb(databaseUrl);

  // Composition root: the only place the control plane picks a runtime driver.
  const machines = new MachineController({ db, runtime: new DockerRuntimeProvider() });
  startIdleStopper(machines, {
    onError: (err) => console.error("idle stopper failed:", err instanceof Error ? err.message : err),
  });

  // Throws on a malformed key; unset means env vars are unavailable (503).
  const masterKeys = masterKeyRingFromEnv(process.env);
  if (!masterKeys) {
    console.warn("MASTER_KEY is not set: `scad env` is disabled until it is.");
  }

  const app = await buildApp({
    db,
    machines,
    ...(masterKeys ? { masterKeys } : {}),
    ...(process.env["SCAD_DATA_DIR"] ? { dataDir: process.env["SCAD_DATA_DIR"] } : {}),
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
