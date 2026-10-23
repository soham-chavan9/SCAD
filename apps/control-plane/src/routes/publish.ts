import { randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import {
  applyManifestDefaults,
  parseManifest,
  slugSchema,
  type ManifestInput,
} from "@scad/shared";
import { appUrl } from "../app-url.js";
import type { Db } from "../db/client.js";
import { apps, auditEvents, releases, users } from "../db/schema.js";
import { ApiError, validationFailed } from "../errors.js";
import { saveTarball, type DataPaths } from "../storage.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type PublishRoutesOpts = {
  db: Db["db"];
  paths: DataPaths;
  baseDomain: string;
};

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
        try {
          const json: unknown = JSON.parse(part.value);
          const parsed = parseManifest(json);
          if (!parsed.success) {
            throw new ApiError(
              400,
              "MANIFEST_INVALID",
              "Manifest validation failed",
              "Fix scad.json fields and republish.",
              {
                issues: parsed.error.issues.map((i) => ({
                  path: i.path.join("."),
                  message: i.message,
                })),
              },
            );
          }
          manifestField = parsed.data;
        } catch (err) {
          if (err instanceof ApiError) throw err;
          throw new ApiError(
            400,
            "MANIFEST_INVALID",
            "Manifest is not valid JSON",
            "Send a JSON object in the manifest field or include scad.json in the tarball.",
          );
        }
      }
    }

    if (!tarball) {
      throw validationFailed("Missing tarball file field");
    }

    const manifestInput = manifestField ?? {};
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

    const url = appUrl({
      slug: appRow.slug,
      ownerHandle: owner.handle,
      baseDomain: opts.baseDomain,
    });

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
