import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import type { Db } from "@scad/control-plane";
import { canViewApp } from "../auth/access.js";
import { loadSessionUser } from "../auth/sessions.js";
import { SESSION_COOKIE } from "../cookies.js";
import { authHost } from "../host.js";
import { buildUpstreamHeaders } from "../identity/headers.js";
import type { IdentityKeyMaterial } from "../identity/keys.js";
import type { AppResolver } from "../resolve.js";
import { upstreamTarget } from "../resolve.js";
import { WAKE_BUDGET_MS, type WakeCoordinator } from "../wake.js";

export type WsProxyOpts = {
  db: Db["db"];
  baseDomain: string;
  resolver: AppResolver;
  keys: IdentityKeyMaterial;
  wake?: WakeCoordinator;
  wakeBudgetMs?: number;
  /** How often open WebSockets re-check the ACL (default 2 s). */
  aclRecheckMs?: number;
};

/** Open WebSockets re-check access this often, so a suspend closes them within 5 s (INV9). */
export const WS_ACL_RECHECK_MS = 2_000;

/** Platform paths must never be upgraded into the app container. */
export function isPlatformUpgradePath(url: string | undefined): boolean {
  const path = (url ?? "/").split("?")[0] ?? "/";
  return path === "/__scad" || path.startsWith("/__scad/");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

/**
 * Proxy WebSocket upgrades to the app container after ACL + identity injection.
 * Attach after Fastify is constructed (`gateway.server`).
 */
export function attachWebSocketProxy(server: HttpServer, opts: WsProxyOpts): void {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false });

  // Piping does not pass a destroy on: when the gateway drops the viewer's
  // socket (ACL re-check, INV9) or the viewer goes away, drop the app side too.
  proxy.on("proxyReqWs", (proxyReq, _req, socket) => {
    proxyReq.once("upgrade", (_res, appSocket: Duplex) => {
      socket.once("close", () => appSocket.destroy());
    });
  });

  proxy.on("error", (_err, _req, socket) => {
    if ("destroy" in socket && typeof socket.destroy === "function") {
      socket.destroy();
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        const host = (req.headers.host ?? "").toLowerCase();
        if (host === authHost(opts.baseDomain) || !host.endsWith(`.${opts.baseDomain}`)) {
          socket.destroy();
          return;
        }
        if (isPlatformUpgradePath(req.url)) {
          socket.destroy();
          return;
        }

        const resolved = await opts.resolver.resolve(host);
        if (!resolved) {
          socket.destroy();
          return;
        }

        const cookies = parseCookies(req.headers.cookie);
        const sessionId = cookies[SESSION_COOKIE];
        const user = sessionId
          ? await loadSessionUser(opts.db, { sessionId, appHost: host })
          : null;
        // Same ACL as HTTP (owner, allowlist, or instance visibility).
        if (!user || !(await canViewApp(opts.db, resolved, user))) {
          socket.destroy();
          return;
        }

        const proto = opts.baseDomain.startsWith("localhost") ? "http" : "https";
        const issuer = `${proto}://${authHost(opts.baseDomain)}`;
        const headers = await buildUpstreamHeaders({
          incoming: req.headers,
          user,
          appId: resolved.appId,
          issuer,
          keys: opts.keys,
        });

        const target = upstreamTarget(resolved);
        if (opts.wake) {
          opts.wake.touch(resolved.appId, user.id);
          if (opts.wake.needsWake(resolved)) {
            const outcome = await opts.wake.hold(
              opts.wake.wake(resolved.appId, target),
              opts.wakeBudgetMs ?? WAKE_BUDGET_MS,
            );
            if (outcome !== "ready") {
              socket.destroy();
              return;
            }
          }
        }
        proxy.ws(req, socket, head, {
          target: `http://${target.host}:${target.port}`,
          headers,
        });
        // Open sockets outlive the upgrade check: re-check the ACL so an
        // operator suspend or an unshare also closes them (INV9: within 5 s).
        const recheck = setInterval(() => {
          canViewApp(opts.db, resolved, user)
            .then((ok) => {
              if (!ok) socket.destroy();
            })
            .catch(() => socket.destroy());
        }, opts.aclRecheckMs ?? WS_ACL_RECHECK_MS);
        recheck.unref();
        socket.once("close", () => clearInterval(recheck));
      } catch {
        socket.destroy();
      }
    })();
  });
}
