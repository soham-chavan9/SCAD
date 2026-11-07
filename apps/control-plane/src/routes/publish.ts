import { randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
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
import { readRootScadJson, ScadJsonTooLargeError } from "../manifest-from-tarball.js";
import { saveTarball, type DataPaths } from "../storage.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type PublishRoutesOpts = {
  db: Db["db"];
  paths: DataPaths;
  baseDomain: string;
};

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

    let [appRow] = await opts.db
      .select()
      .from(apps)
      .where(and(eq(apps.ownerId, ownerId), eq(apps.slug, slugCandidate)))
      .limit(1);

    if (!appRow) {
      [appRow] = await opts.db
        .insert(apps)
        .values({
          slug: slugCandidate,
          ownerId,
          status: "building",
          visibility: "allowlist",
        })
        .returning();
    } else {
      await opts.db.update(apps).set({ status: "building" }).where(eq(apps.id, appRow.id));
      appRow = { ...appRow, status: "building" };
    }

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
