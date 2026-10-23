import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { handleSchema } from "@scad/shared";
import { issuePat } from "../auth/pat.js";
import type { Db } from "../db/client.js";
import { pats, users } from "../db/schema.js";
import type { DeviceStore } from "../device-store.js";
import { ApiError, validationFailed } from "../errors.js";

export type AuthDeviceRoutesOpts = {
  db: Db["db"];
  devices: DeviceStore;
  operatorEmails: Set<string>;
  publicBaseUrl: string;
};

function emailToHandle(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const handle = cleaned.length >= 1 ? cleaned.slice(0, 39) : "user";
  const parsed = handleSchema.safeParse(handle);
  if (parsed.success) return parsed.data;
  return `u${handle.replace(/[^a-z0-9]/g, "").slice(0, 37) || "ser"}`;
}

export const authDeviceRoutes: FastifyPluginAsync<AuthDeviceRoutesOpts> = async (app, opts) => {
  app.post(
    "/v1/auth/device",
    { config: { public: true } },
    async () => {
      const pending = opts.devices.create();
      return {
        device_code: pending.deviceCode,
        user_code: pending.userCode,
        verification_uri: `${opts.publicBaseUrl}/v1/auth/device/approve`,
        interval: pending.intervalSeconds,
      };
    },
  );

  app.post(
    "/v1/auth/device/token",
    { config: { public: true } },
    async (request, reply) => {
      const body = z.object({ device_code: z.string().min(1) }).safeParse(request.body);
      if (!body.success) {
        throw validationFailed("device_code is required");
      }
      const result = opts.devices.consumePat(body.data.device_code);
      if (result === "expired") {
        throw new ApiError(
          400,
          "VALIDATION_FAILED",
          "Device code expired or unknown",
          "Run `scad login` again to start a new device flow.",
        );
      }
      if (result === "pending") {
        return reply.status(400).send({ error: "authorization_pending" });
      }
      return { pat: result };
    },
  );

  /**
   * Local/dev approval: authorize a pending device code for an allowlisted email.
   * Browser GitHub OAuth lands in T0.6; this unlocks CLI login for M0.
   */
  app.post(
    "/v1/auth/device/approve",
    { config: { public: true } },
    async (request) => {
      const body = z
        .object({
          user_code: z.string().min(1),
          email: z.string().email(),
        })
        .safeParse(request.body);
      if (!body.success) {
        throw validationFailed("user_code and email are required");
      }

      const email = body.data.email.toLowerCase();
      if (opts.operatorEmails.size > 0 && !opts.operatorEmails.has(email)) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Email is not on the operator allowlist",
          "Ask an operator to add your email to OPERATOR_EMAILS.",
        );
      }

      const pending = opts.devices.getByUserCode(body.data.user_code);
      if (!pending) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Unknown or expired user_code",
          "Run `scad login` again and approve the new code.",
        );
      }

      let [user] = await opts.db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!user) {
        const handleBase = emailToHandle(email);
        let handle = handleBase;
        for (let i = 0; i < 8; i++) {
          try {
            [user] = await opts.db
              .insert(users)
              .values({
                email,
                displayName: email,
                handle,
                role: "member",
                status: "active",
              })
              .returning();
            break;
          } catch {
            handle = `${handleBase.slice(0, 35)}${i + 1}`;
          }
        }
        if (!user) {
          throw new ApiError(
            500,
            "INTERNAL",
            "Could not create user",
            "Retry approval or contact an operator.",
          );
        }
      }

      const issued = issuePat();
      await opts.db.insert(pats).values({
        userId: user.id,
        tokenHash: issued.tokenHash,
        name: "device-login",
      });

      const ok = opts.devices.authorize(body.data.user_code, user.id, issued.token);
      if (!ok) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Unknown or expired user_code",
          "Run `scad login` again and approve the new code.",
        );
      }

      return { ok: true, email: user.email, handle: user.handle };
    },
  );
};
