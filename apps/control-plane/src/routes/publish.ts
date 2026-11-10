import { randomUUID } from "node:crypto";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  AppUrlError,
  applyManifestDefaults,
  describeManifestIssues,
  formatAppUrl,
  parseManifest,
  slugSchema,
  type ManifestInput,
} from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, auditEvents, releases, users } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";
import { lockApp } from "../lifecycle/app-lock.js";
import { renewedExpiry } from "../lifecycle/policy.js";
import { readRootScadJson, ScadJsonTooLargeError } from "../manifest-from-tarball.js";
import { saveTarball, type DataPaths } from "../storage.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** AGENTS §14: 10 live apps per builder (this instance). */
export const MAX_LIVE_APPS = 10;
/** Statuses that hold a slot; deleted and expired apps free theirs. */
const LIVE_STATUSES = ["building", "running", "stopped", "suspended"] as const;
/** Serializes the live-app count + insert across concurrent publishes. */
const LIVE_APPS_LOCK_KEY = 0x5cad_0001;

export type PublishRoutesOpts = {
  db: Db["db"];
  paths: DataPaths;
  baseDomain: string;
  /** Override for tests; defaults to {@link MAX_LIVE_APPS}. */
  maxLiveApps?: number;
};

function liveAppLimitExceeded(liveApps: number, maxLiveApps: number): ApiError {
  return new ApiError(
    403,
    "LIMIT_EXCEEDED",
    `This SCAD instance already has ${liveApps} live apps (limit ${maxLiveApps})`,
    "Delete an app you no longer need (MCP delete_app, or DELETE /v1/apps/:id), or republish an existing app under its current name, then retry. An operator can raise the limit.",
    { live_apps: liveApps, max_live_apps: maxLiveApps },
  );
}

/** Resource requests over their §11 cap are a limit, not a typo. */
function isOverCap(issue: { code: string; path: PropertyKey[] }): boolean {
  return issue.code === "too_big" && issue.path[0] === "resources";
}

function manifestInvalid(message: string, hint: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(400, "MANIFEST_INVALID", message, hint, details);
}

/** Validate a manifest JSON string (from the form field or the tarball's scad.json). */
function parseManifestText(text: string, source: "scad.json" | "manifest field"): ManifestInput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw manifestInvalid(
      `${source} is not valid JSON`,
      `Make ${source === "scad.json" ? "scad.json" : "the manifest field"} a JSON object (check commas and quotes; scad.json allows no comments), then republish.`,
    );
  }
  const parsed = parseManifest(json);
  if (!parsed.success) {
    const { issues, hint } = describeManifestIssues(parsed.error);
    if (parsed.error.issues.some(isOverCap)) {
      const capped = issues.filter((_, i) => isOverCap(parsed.error.issues[i]!));
      throw new ApiError(
        400,
        "LIMIT_EXCEEDED",
        `${source} asks for more than the platform allows`,
        `Lower ${capped.map((c) => `"${c.path}" (${c.message})`).join(" and ")} in scad.json, then republish. Defaults are 512 MB memory and 1 GB disk.`,
        { source, issues: capped },
      );
    }
    throw manifestInvalid(`${source} failed validation`, hint, { source, issues });
  }
  return parsed.data;
}

function slugFromName(name: string): string | null {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parsed = slugSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : null;
}

export const publishRoutes: FastifyPluginAsync<PublishRoutesOpts> = async (app, opts) => {
  app.post("/v1/apps/publish", async (request, reply) => {
    if (!request.isMultipart()) {
      throw validationFailed("Expected multipart form data with a tarball field");
    }

    let tarball: Buffer | null = null;
    let nameField: string | undefined;
    let manifestField: ManifestInput | undefined;

    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "tarball") {
          continue;
        }
        const buf = await part.toBuffer();
        if (buf.byteLength > MAX_UPLOAD_BYTES) {
          throw new ApiError(
            413,
            "UPLOAD_TOO_LARGE",
            `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`,
            "Reduce the publish directory size (max 100 MB) and retry.",
          );
        }
        tarball = buf;
      } else if (part.fieldname === "name" && typeof part.value === "string") {
        nameField = part.value;
      } else if (part.fieldname === "manifest" && typeof part.value === "string") {
        manifestField = parseManifestText(part.value, "manifest field");
      }
    }

    if (!tarball) {
      throw validationFailed("Missing tarball file field");
    }

    // An explicit manifest field wins; otherwise scad.json at the tarball root (§11).
    let manifestInput: ManifestInput = manifestField ?? {};
    if (!manifestField) {
      let text: string | null;
      try {
        text = await readRootScadJson(tarball);
      } catch (err) {
        if (err instanceof ScadJsonTooLargeError) {
          throw manifestInvalid(err.message, "Keep scad.json under 64 KB; it holds settings, not data.");
        }
        throw validationFailed("Tarball could not be read", {
          hint: "Republish with `scad publish`, which builds a valid tarball.",
        });
      }
      if (text !== null) {
        manifestInput = parseManifestText(text, "scad.json");
      }
    }
    const resolved = applyManifestDefaults(manifestInput);

    const slugCandidate =
      (nameField ? slugFromName(nameField) : null) ??
      (resolved.name ? slugFromName(resolved.name) : null);
    if (!slugCandidate) {
      throw new ApiError(
        400,
        "VALIDATION_FAILED",
        "Could not derive a valid app slug",
        "Pass name= as a slug ([a-z0-9-]{3,40}) or set manifest.name.",
      );
    }

    const ownerId = request.user.id;
    const [owner] = await opts.db.select().from(users).where(eq(users.id, ownerId)).limit(1);
    if (!owner) {
      throw new ApiError(401, "UNAUTHENTICATED", "User not found", "Run `scad login` again.");
    }

    const maxLiveApps = opts.maxLiveApps ?? MAX_LIVE_APPS;
    const appRow = await opts.db.transaction(async (tx) => {
      const findExisting = () =>
        tx
          .select()
          .from(apps)
          .where(and(eq(apps.ownerId, ownerId), eq(apps.slug, slugCandidate)))
          .limit(1);
      let [existing] = await findExisting();
      if (existing) {
        // Wait out a delete in progress (owner or expiry), then decide on the
        // row as it is now: a deleted app starts fresh.
        await lockApp(tx, existing.id);
        [existing] = await findExisting();
      }
      if (existing?.status === "suspended") {
        // An owner must not lift an operator's suspension by republishing (T2.6).
        throw new ApiError(
          403,
          "APP_SUSPENDED",
          "This app is suspended by an operator",
          "Ask an operator to lift the suspension (scad admin unsuspend-app) before publishing again.",
        );
      }
      const takesNewSlot = !existing || existing.status === "deleted" || existing.status === "expired";
      if (takesNewSlot) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LIVE_APPS_LOCK_KEY})`);
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(apps)
          .where(inArray(apps.status, [...LIVE_STATUSES]));
        const liveApps = row?.n ?? 0;
        if (liveApps >= maxLiveApps) throw liveAppLimitExceeded(liveApps, maxLiveApps);
      }
      // Publishing counts as use: the 30-day expiry clock restarts (D8, T2.5).
      const expiry = renewedExpiry(new Date());
      if (!existing) {
        const [created] = await tx
          .insert(apps)
          .values({ slug: slugCandidate, ownerId, status: "building", visibility: "allowlist", ...expiry })
          .returning();
        return created;
      }
      await tx.update(apps).set({ status: "building", ...expiry }).where(eq(apps.id, existing.id));
      return { ...existing, status: "building" as const, ...expiry };
    });

    if (!appRow) {
      throw new ApiError(500, "INTERNAL", "Failed to create app", "Retry publish.");
    }

    const versionRows = await opts.db
      .select({ v: max(releases.version) })
      .from(releases)
      .where(eq(releases.appId, appRow.id));
    const nextVersion = (versionRows[0]?.v ?? 0) + 1;

    const releaseId = randomUUID();
    const [release] = await opts.db
      .insert(releases)
      .values({
        id: releaseId,
        appId: appRow.id,
        version: nextVersion,
        imageRef: "",
        manifest: resolved,
        status: "building",
        buildLogRef: opts.paths.logPath(releaseId),
      })
      .returning();

    if (!release) {
      throw new ApiError(500, "INTERNAL", "Failed to create release", "Retry publish.");
    }

    await saveTarball(opts.paths, release.id, tarball);

    await opts.db.insert(auditEvents).values({
      actorId: ownerId,
      appId: appRow.id,
      action: "app.publish",
      metadata: { releaseId: release.id, version: nextVersion, slug: slugCandidate },
    });

    let url: string;
    try {
      url = formatAppUrl({
        slug: appRow.slug,
        ownerHandle: owner.handle,
        baseDomain: opts.baseDomain,
      });
    } catch (err) {
      if (err instanceof AppUrlError) {
        throw new ApiError(
          500,
          "INTERNAL",
          "Could not determine the app host URL",
          "Ensure BASE_DOMAIN is set and your account has a valid handle, then republish.",
          { reason: err.reason },
        );
      }
      throw err;
    }

    return reply.status(202).send({
      app: {
        id: appRow.id,
        slug: appRow.slug,
        ownerId: appRow.ownerId,
        status: appRow.status,
      },
      release: {
        id: release.id,
        version: release.version,
        status: release.status,
      },
      url,
    });
  });
};
