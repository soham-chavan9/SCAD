import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { isUuid } from "@scad/shared";
import type { Db } from "../db/client.js";
import { auditEvents, releases } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { MachineController } from "../machines/controller.js";
import type { MasterKeyRing } from "../secrets/crypto.js";
import { listEnv, loadRuntimeEnv, writeEnv } from "../secrets/env-store.js";
import { assertInternal } from "./internal-builds.js";
import { findOwnedApp } from "./share.js";

export type EnvRoutesOpts = {
  db: Db["db"];
  internalToken: string;
  masterKeys?: MasterKeyRing;
  machines?: MachineController;
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_KEYS_PER_REQUEST = 100;
const MAX_VALUE_BYTES = 32 * 1024;

function invalid(message: string): ApiError {
  return new ApiError(
    400,
    "VALIDATION_FAILED",
    message,
    'Send {"KEY": "value", ...} (null deletes a key) and optionally "secret": ["KEY"]. Keys match [A-Za-z_][A-Za-z0-9_]*.',
  );
}

/**
 * Body: `{KEY: value | null, ..., secret?: string[]}` (AGENTS §8). `secret` is
 * reserved: it lists which of the keys in this request are write-only secrets.
 */
function parsePutBody(body: unknown): { changes: Record<string, string | null>; secret: Set<string> } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("Body must be a JSON object");
  }
  const changes: Record<string, string | null> = {};
  let secretList: unknown = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "secret") {
      secretList = value;
      continue;
    }
    if (!ENV_KEY.test(key)) throw invalid(`Invalid env key "${key.slice(0, 64)}"`);
    if (value !== null && typeof value !== "string") throw invalid(`Value for ${key} must be a string or null`);
    if (typeof value === "string" && Buffer.byteLength(value) > MAX_VALUE_BYTES) {
      throw invalid(`Value for ${key} is over 32 KB`);
    }
    changes[key] = value;
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) throw invalid("No env keys given");
  if (keys.length > MAX_KEYS_PER_REQUEST) throw invalid(`At most ${MAX_KEYS_PER_REQUEST} keys per request`);
  if (!Array.isArray(secretList) || !secretList.every((k) => typeof k === "string")) {
    throw invalid('"secret" must be an array of key names');
  }
  const secret = new Set(secretList as string[]);
  for (const k of secret) {
    if (typeof changes[k] !== "string") throw invalid(`"secret" lists ${k.slice(0, 64)}, which is not set in this request`);
  }
  return { changes, secret };
}

export const envRoutes: FastifyPluginAsync<EnvRoutesOpts> = async (app, opts) => {
  function requireKeys(): MasterKeyRing {
    if (!opts.masterKeys) {
      throw new ApiError(
        503,
        "INTERNAL",
        "Env vars are not available on this instance",
        "The operator must set MASTER_KEY (openssl rand -base64 32) and restart the control plane.",
      );
    }
    return opts.masterKeys;
  }

  app.get<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug/env", async (request) => {
    const keys = requireKeys();
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    return { env: await listEnv(opts.db, keys, owned.id) };
  });

  app.put<{ Params: { idOrSlug: string } }>("/v1/apps/:idOrSlug/env", async (request) => {
    const keys = requireKeys();
    const owned = await findOwnedApp(opts.db, request.user.id, request.params.idOrSlug);
    const { changes, secret } = parsePutBody(request.body);

    await writeEnv(opts.db, keys, owned.id, changes, secret);
    await opts.db.insert(auditEvents).values({
      actorId: request.user.id,
      appId: owned.id,
      action: "app.env.set",
      // Key names only; values never reach audit metadata (INV7, INV12).
      metadata: {
        set: Object.keys(changes).filter((k) => changes[k] !== null).sort(),
        unset: Object.keys(changes).filter((k) => changes[k] === null).sort(),
        secret: [...secret].sort(),
      },
    });

    let applied: "redeployed" | "next_publish" = "next_publish";
    if (opts.machines) {
      try {
        const env = await loadRuntimeEnv(opts.db, keys, owned.id);
        if (await opts.machines.redeploy(owned.id, env)) applied = "redeployed";
      } catch {
        throw new ApiError(
          500,
          "INTERNAL",
          "Env saved, but the app could not be restarted with it",
          "Run `scad publish` again to apply the new env.",
        );
      }
    }
    return { env: await listEnv(opts.db, keys, owned.id), applied };
  });

  /** Builder fetches decrypted env right before deploy, only for a release it is building. */
  app.post<{ Params: { id: string } }>(
    "/internal/builds/:id/runtime-env",
    { config: { public: true } },
    async (request) => {
      assertInternal(request, opts.internalToken);
      if (!isUuid(request.params.id)) {
        throw new ApiError(404, "NOT_FOUND", "Release not found", "Unknown release id.");
      }
      const [release] = await opts.db
        .select({ appId: releases.appId, status: releases.status })
        .from(releases)
        .where(eq(releases.id, request.params.id))
        .limit(1);
      if (!release) {
        throw new ApiError(404, "NOT_FOUND", "Release not found", "Unknown release id.");
      }
      if (release.status !== "building") {
        throw new ApiError(409, "FORBIDDEN", "Release is not building", "Runtime env is only served for a release being built.");
      }
      if (!opts.masterKeys) return { env: {} };
      return { env: await loadRuntimeEnv(opts.db, opts.masterKeys, release.appId) };
    },
  );
};
