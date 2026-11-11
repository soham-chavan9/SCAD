import type { FastifyPluginAsync } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { apiHostFor, authHostFor, normalizeBaseDomain } from "@scad/shared";
import type { Db } from "../db/client.js";
import { apps, users } from "../db/schema.js";
import { parseAppHost } from "./internal.js";

export type TlsAskRoutesOpts = {
  db: Db["db"];
  baseDomain: string;
};

const askQuery = z.object({ domain: z.string().min(1).max(253) });

/**
 * Caddy on-demand TLS `ask` endpoint (T3.1). Caddy calls
 * `GET /internal/tls-ask?domain=<host>` before it requests a certificate;
 * 200 = issue, anything else = refuse. Only the auth host, the API host, and
 * hosts of apps that exist (not deleted) get a certificate, so a stranger
 * cannot make us burn ACME rate limits on random names.
 *
 * No secret: Caddy's ask cannot send headers, and the answer only says
 * whether a hostname is served, which visiting it reveals anyway. The public
 * TLS front never forwards `/internal/*` (deploy/Caddyfile).
 */
export const tlsAskRoutes: FastifyPluginAsync<TlsAskRoutesOpts> = async (app, opts) => {
  const base = normalizeBaseDomain(opts.baseDomain).toLowerCase();
  const fixedHosts = new Set([authHostFor(base), apiHostFor(base)]);

  app.get("/internal/tls-ask", { config: { public: true } }, async (request, reply) => {
    const parsed = askQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ allowed: false });
    }
    const domain = parsed.data.domain.trim().toLowerCase().replace(/\.$/, "");
    if (fixedHosts.has(domain)) {
      return { allowed: true };
    }
    const host = parseAppHost(domain, base);
    if (!host) {
      return reply.status(404).send({ allowed: false });
    }
    const rows = await opts.db
      .select({ id: apps.id })
      .from(apps)
      .innerJoin(users, eq(apps.ownerId, users.id))
      .where(and(eq(apps.slug, host.slug), eq(users.handle, host.ownerHandle), ne(apps.status, "deleted")))
      .limit(1);
    if (rows.length === 0) {
      return reply.status(404).send({ allowed: false });
    }
    return { allowed: true };
  });
};
