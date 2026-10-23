import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { slugSchema } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, auditEvents } from "../db/schema.js";
import { validationFailed } from "../errors.js";

const createAppBody = z.object({
  slug: slugSchema,
});

export type AppsRoutesOpts = {
  db: Db["db"];
};

export const appsRoutes: FastifyPluginAsync<AppsRoutesOpts> = async (app, opts) => {
  app.post("/v1/apps", async (request, reply) => {
    const parsed = createAppBody.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("Invalid app create payload", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const { slug } = parsed.data;
    const ownerId = request.user.id;

    const [app] = await opts.db
      .insert(apps)
      .values({
        slug,
        ownerId,
        status: "stopped",
        visibility: "allowlist",
      })
      .returning();

    if (!app) {
      throw validationFailed("Failed to create app");
    }

    await opts.db.insert(auditEvents).values({
      actorId: ownerId,
      appId: app.id,
      action: "app.create",
      metadata: { slug },
    });

    return reply.status(201).send({
      app: {
        id: app.id,
        slug: app.slug,
        ownerId: app.ownerId,
        status: app.status,
        visibility: app.visibility,
        createdAt: app.createdAt.toISOString(),
      },
    });
  });
};
