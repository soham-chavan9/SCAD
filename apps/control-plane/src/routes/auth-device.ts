import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { handleSchema } from "@scad/shared";
import { issuePat } from "../auth/pat.js";
import type { Db } from "../db/client.js";
import { pats, users } from "../db/schema.js";
import type { DeviceStore } from "../device-store.js";
import type { Mailer } from "../lifecycle/jobs.js";
import { ApiError, validationFailed } from "../errors.js";

export type AuthDeviceRoutesOpts = {
  db: Db["db"];
  devices: DeviceStore;
  operatorEmails: Set<string>;
  publicBaseUrl: string;
  /** Sends `scad login` approval links (T3.4). Without it, only local approval works. */
  mailer?: Mailer;
};

/** Approval emails per address per 15 minutes, and for the whole instance per hour (T3.4). */
export const LOGIN_EMAILS_PER_ADDRESS = 5;
export const LOGIN_EMAILS_PER_HOUR = 50;

class WindowCounter {
  readonly #hits = new Map<string, number[]>();
  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}code{font-size:1.4em;letter-spacing:.1em}button{font:inherit;padding:.6rem 1.2rem}</style></head>
<body>${body}</body>
</html>`;
}

function formatUserCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Empty allowlist denies everyone. The caller-supplied email must be listed. */
export function emailMayApprove(operatorEmails: ReadonlySet<string>, email: string): boolean {
  return operatorEmails.size > 0 && operatorEmails.has(email.toLowerCase());
}

/** Device approval is a local control-plane action. Ignore forwarded headers. */
export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const host = ip.toLowerCase().replace(/^::ffff:/, "");
  return host === "127.0.0.1" || host === "::1";
}

/**
 * True when the request came through a reverse proxy (T3.1). Behind the TLS
 * front, a proxy running on this host would make every remote caller look
 * like loopback, so any forwarding header disqualifies local approval.
 */
export function cameThroughProxy(headers: Record<string, string | string[] | undefined>): boolean {
  return [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "forwarded",
    "x-real-ip",
    "via",
  ].some((name) => headers[name] !== undefined);
}

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

/**
 * Authorize a pending device code for `email` (an operator, already checked):
 * create the account if needed, issue a PAT, hand it to the waiting CLI.
 */
async function approveForEmail(
  opts: AuthDeviceRoutesOpts,
  email: string,
  userCode: string,
): Promise<typeof users.$inferSelect> {
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

  const ok = opts.devices.authorize(userCode, user.id, issued.token);
  if (!ok) {
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Unknown or expired user_code",
      "Run `scad login` again and approve the new code.",
    );
  }

  return user;
}

export const authDeviceRoutes: FastifyPluginAsync<AuthDeviceRoutesOpts> = async (app, opts) => {
  const emailsSent = new WindowCounter();

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 4 * 1024 },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  /**
   * Start `scad login`. With `email` (T3.4), an operator gets an approval link
   * by email, so login works from any machine. The answer is the same whether
   * or not the address may log in, so it does not reveal who the operators are.
   */
  app.post("/v1/auth/device", { config: { public: true } }, async (request) => {
    const body = z
      .object({ email: z.string().email().max(254).optional() })
      .safeParse(request.body ?? {});
    if (!body.success) {
      throw validationFailed("email must be an email address", {});
    }
    const pending = opts.devices.create();
    const response = {
      device_code: pending.deviceCode,
      user_code: pending.userCode,
      verification_uri: `${opts.publicBaseUrl}/v1/auth/device/approve`,
      interval: pending.intervalSeconds,
    };
    const email = body.data.email?.toLowerCase();
    if (!email) return response;
    if (!opts.mailer) {
      throw new ApiError(
        503,
        "INTERNAL",
        "This SCAD instance cannot send email, so it cannot approve a login by email",
        "Ask the SCAD operator to set SMTP_URL on the control plane, then run `scad login` again.",
      );
    }
    if (
      !emailsSent.take(`email:${email}`, LOGIN_EMAILS_PER_ADDRESS, 15 * 60_000) ||
      !emailsSent.take("all", LOGIN_EMAILS_PER_HOUR, 60 * 60_000)
    ) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many login emails were requested",
        "Wait 15 minutes, then run `scad login` again. Use the newest email only.",
      );
    }
    if (emailMayApprove(opts.operatorEmails, email)) {
      const token = opts.devices.issueEmailApproval(pending.userCode, email);
      if (token) {
        const link = `${opts.publicBaseUrl}/v1/auth/device/email?token=${encodeURIComponent(token)}`;
        await opts.mailer.send({
          to: email,
          subject: `Approve SCAD login (code ${formatUserCode(pending.userCode)})`,
          text:
            `Someone, hopefully you, is logging in to SCAD with the code ${formatUserCode(pending.userCode)}.\n\n` +
            `If that code is on your screen, open this link and press Approve:\n${link}\n\n` +
            "The link works once and expires in 10 minutes. If this wasn't you, ignore this email.\n",
        });
      }
    }
    return {
      ...response,
      approval: "email",
      message: `If ${email} may publish on this SCAD, an approval link is on its way. Open it and press Approve.`,
    };
  });

  /** The emailed link opens this page; only its button approves (mail scanners only GET). */
  app.get("/v1/auth/device/email", { config: { public: true } }, async (request, reply) => {
    const token = String((request.query as { token?: unknown }).token ?? "");
    const found = token ? opts.devices.peekEmailApproval(token) : undefined;
    void reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .type("text/html");
    if (!found) {
      return reply
        .status(410)
        .send(
          page(
            "Link expired",
            "<h1>This link has expired or was already used</h1><p>Run <b>scad login</b> again to get a new one.</p>",
          ),
        );
    }
    return reply.send(
      page(
        "Approve SCAD login",
        `<h1>Approve SCAD login?</h1>
<p>Only approve if this code is on your screen right now:</p>
<p><code>${escapeHtml(formatUserCode(found.userCode))}</code></p>
<form method="post" action="/v1/auth/device/email">
<input type="hidden" name="token" value="${escapeHtml(token)}"/>
<button type="submit">Approve</button>
</form>`,
      ),
    );
  });

  app.post("/v1/auth/device/email", { config: { public: true } }, async (request, reply) => {
    const token = String((request.body as { token?: unknown } | undefined)?.token ?? "");
    const found = token ? opts.devices.takeEmailApproval(token) : undefined;
    void reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .type("text/html");
    if (!found || !emailMayApprove(opts.operatorEmails, found.email)) {
      return reply
        .status(410)
        .send(
          page(
            "Link expired",
            "<h1>This link has expired or was already used</h1><p>Run <b>scad login</b> again to get a new one.</p>",
          ),
        );
    }
    await approveForEmail(opts, found.email, found.userCode);
    return reply.send(
      page(
        "Approved",
        "<h1>Approved</h1><p>You're logged in. You can close this tab and go back to your terminal or your AI.</p>",
      ),
    );
  });

  app.post("/v1/auth/device/token", { config: { public: true } }, async (request, reply) => {
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
        "Run `scad login --email you@example.com` again and use the newest email.",
      );
    }
    if (result === "pending") {
      return reply.status(400).send({ error: "authorization_pending" });
    }
    return { pat: result };
  });

  /**
   * Local/dev approval: authorize a pending device code for an allowlisted email.
   * Browser GitHub OAuth lands in T0.6; this unlocks CLI login for M0.
   */
  app.post("/v1/auth/device/approve", { config: { public: true } }, async (request) => {
    const body = z
      .object({
        user_code: z.string().min(1),
        email: z.string().email(),
      })
      .safeParse(request.body);
    if (!body.success) {
      throw validationFailed("user_code and email are required");
    }

    if (!isLoopbackIp(request.ip) || cameThroughProxy(request.headers)) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Device approval is only available from localhost",
        "From any other computer, run `scad login --email you@example.com` and press Approve in the email.",
      );
    }

    const email = body.data.email.toLowerCase();
    if (!emailMayApprove(opts.operatorEmails, email)) {
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

    const user = await approveForEmail(opts, email, body.data.user_code);
    return { ok: true, email: user.email, handle: user.handle };
  });
};
