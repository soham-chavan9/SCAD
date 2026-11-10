export const PACKAGE_NAME = "control-plane" as const;

export { buildApp } from "./app.js";
export { createDb, type Db } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { assertTruncateAllowed } from "./db/test-db.js";
export { hashPat, issuePat } from "./auth/pat.js";
export * as schema from "./db/schema.js";
export { IDLE_STOP_MS, MachineController, startIdleStopper } from "./machines/controller.js";
