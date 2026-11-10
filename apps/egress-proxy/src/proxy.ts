/**
 * SCAD egress proxy (T2.1, INV1/INV2). The only way out for app containers.
 *
 * - Apps sit on internal Docker networks with no default route. This proxy is
 *   attached to each app network and to one external network.
 * - It identifies the calling app by source IP: each app has its own network,
 *   so the subnet names the app. Policies are files `{appId, subnet, allow}`
 *   written by the runtime driver into a directory mounted read-only here, so
 *   apps have no control channel to reach.
 * - A host is allowed only if the app's manifest `egress` AND the operator's
 *   EGRESS_ALLOWED_DOMAINS both allow it. Unset or empty means `*` (any
 *   domain an app declares, T2.1b); `none` refuses everything.
 * - The proxy resolves DNS itself and refuses if ANY resolved address is
 *   private, loopback, link-local, metadata, or otherwise non-public, then
 *   connects to the vetted address (defeats DNS rebinding).
 * - Logs host and decision only, never paths or headers (INV12).
 *
 * Uses only Node built-ins and erasable TypeScript, so the image runs it with
 * `node --experimental-strip-types` and builds with `--network=none`.
 */
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";

export type AppPolicy = { appId: string; subnet: string; allow: string[] };
export type Resolved = { address: string; family: number };

export type EgressProxyOptions = {
  policyDir: string;
  /** Operator-approved patterns (`*` approves any manifest-declared domain). Empty = deny all; see parseOperatorAllow. */
  operatorAllow: string[];
  lookup?: (host: string) => Promise<Resolved[]>;
  dial?: (ip: string, port: number) => net.Socket;
  log?: (line: string) => void;
  reloadMs?: number;
  /** Test hook: override the client's source address. */
  sourceAddress?: (socket: net.Socket) => string | undefined;
  /** Per-app concurrent connection cap. */
  maxConnectionsPerApp?: number;
};

const CONNECT_PORTS = new Set([443]);
const HTTP_PORTS = new Set([80]);
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Everything that is not a public unicast address. */
const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(prefix, bits, "ipv6");
}

/** True unless `ip` is a public unicast IP literal. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  // IPv4-mapped IPv6 is refused here; BlockList would treat it like plain IPv4.
  if (/^::ffff:/i.test(ip)) return true;
  return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function matches(host: string, pattern: string): boolean {
  const p = normalizeHost(pattern);
  if (p === "*") return true;
  if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

/** Allowed only if the app's manifest AND the operator both allow `host`. */
export function hostAllowed(host: string, appAllow: string[], operatorAllow: string[]): boolean {
  const h = normalizeHost(host);
  if (net.isIP(h) !== 0) return false;
  const byApp = appAllow.some((p) => p !== "*" && matches(h, p));
  return byApp && operatorAllow.some((p) => matches(h, p));
}

/**
 * Reads EGRESS_ALLOWED_DOMAINS. Unset or empty means `*`: apps may reach any
 * public domain they declare in scad.json (human decision, Nov 9). `none`
 * refuses everything. Anything else is a comma list that narrows what apps
 * may declare.
 */
export function parseOperatorAllow(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return ["*"];
  if (entries.includes("none")) {
    if (entries.length > 1) {
      throw new Error('EGRESS_ALLOWED_DOMAINS: "none" must be used alone (it refuses all egress)');
    }
    return [];
  }
  return entries;
}

/** One line for the startup log. */
export function describeOperatorPolicy(operatorAllow: string[]): string {
  if (operatorAllow.length === 0) {
    return "EGRESS_ALLOWED_DOMAINS=none: every egress request is refused.";
  }
  if (operatorAllow.includes("*")) {
    return "egress policy: apps may reach any domain an app declares in scad.json (private and reserved addresses stay blocked).";
  }
  return `egress policy: apps may reach declared domains matching ${operatorAllow.join(", ")}.`;
}

function plainAddress(ip: string): string {
  return ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1");
}

/** Source IP -> app, by the subnet of the app's private network. */
export class PolicyIndex {
  readonly #entries: { policy: AppPolicy; list: net.BlockList }[] = [];

  constructor(policies: AppPolicy[]) {
    for (const policy of policies) {
      const [prefix, bitsText] = policy.subnet.split("/");
      const bits = Number(bitsText);
      const family = net.isIP(prefix ?? "");
      if (!prefix || family === 0 || !Number.isInteger(bits)) continue;
      const list = new net.BlockList();
      list.addSubnet(prefix, bits, family === 4 ? "ipv4" : "ipv6");
      this.#entries.push({ policy, list });
    }
  }

  appFor(sourceIp: string): AppPolicy | undefined {
    const ip = plainAddress(sourceIp);
    const family = net.isIP(ip);
    if (family === 0) return undefined;
    return this.#entries.find((e) => e.list.check(ip, family === 4 ? "ipv4" : "ipv6"))?.policy;
  }
}

function isPolicy(value: unknown): value is AppPolicy {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const allow = v["allow"];
  return (
    typeof v["appId"] === "string" &&
    typeof v["subnet"] === "string" &&
    Array.isArray(allow) &&
    allow.every((a) => typeof a === "string")
  );
}

/** Warn once per distinct failure, not on every 1 s reload. */
let lastPolicyDirError = "";

export async function loadPolicies(dir: string): Promise<AppPolicy[]> {
  let names: string[];
  try {
    names = await readdir(dir);
    lastPolicyDirError = "";
  } catch (err) {
    const code = (err as { code?: string }).code ?? "unknown";
    if (code !== lastPolicyDirError) {
      lastPolicyDirError = code;
      // Every app is refused as "unknown source" until this is fixed.
      console.warn(`egress policy dir ${dir} is unreadable (${code}): all egress is refused`);
    }
    return [];
  }
  const out: AppPolicy[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (isPolicy(parsed)) out.push(parsed);
    } catch {
      // Half-written or bad file: skip until the next reload.
    }
  }
  return out;
}

function parseTarget(authority: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(authority.trim());
  if (!m?.[1] || !m[2]) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: normalizeHost(m[1]), port };
}

export function createEgressProxy(opts: EgressProxyOptions): http.Server {
  const lookup =
    opts.lookup ??
    (async (host: string): Promise<Resolved[]> => dnsLookup(host, { all: true, verbatim: true }));
  const dial = opts.dial ?? ((ip: string, port: number) => net.connect({ host: ip, port }));
  const log = opts.log ?? ((line: string) => console.log(line));
  const maxPerApp = opts.maxConnectionsPerApp ?? 128;
  const active = new Map<string, number>();
  let index = new PolicyIndex([]);
  let loadedAt = 0;

  async function policyFor(socket: net.Socket): Promise<AppPolicy | undefined> {
    const now = Date.now();
    if (now - loadedAt > (opts.reloadMs ?? 1000)) {
      index = new PolicyIndex(await loadPolicies(opts.policyDir));
      loadedAt = now;
    }
    const source = opts.sourceAddress?.(socket) ?? socket.remoteAddress;
    return source ? index.appFor(source) : undefined;
  }

  /** Decide and resolve. Returns the vetted IP or a refusal reason. */
  async function vet(
    policy: AppPolicy | undefined,
    host: string,
    port: number,
    ports: Set<number>,
  ): Promise<{ ip: string } | { reason: string }> {
    if (!policy) return { reason: "unknown source (not a SCAD app)" };
    if (!ports.has(port)) return { reason: `port ${port} not allowed` };
    if (!hostAllowed(host, policy.allow, opts.operatorAllow)) {
      return { reason: "host not in the app's scad.json egress list or not approved by the operator" };
    }
    let addresses: Resolved[];
    try {
      addresses = await lookup(host);
    } catch {
      return { reason: "DNS lookup failed" };
    }
    const first = addresses[0];
    if (!first) return { reason: "DNS lookup failed" };
    if (addresses.some((a) => isBlockedAddress(a.address))) {
      return { reason: "host resolves to a private or reserved address" };
    }
    return { ip: first.address };
  }

  function track(appId: string): (() => void) | null {
    const n = active.get(appId) ?? 0;
    if (n >= maxPerApp) return null;
    active.set(appId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.set(appId, (active.get(appId) ?? 1) - 1);
    };
  }

  function deny(appId: string | undefined, host: string, reason: string): string {
    log(`egress deny app=${appId ?? "-"} host=${host} reason="${reason}"`);
    return `SCAD egress refused ${host}: ${reason}. Declare the domain in scad.json "egress" (the operator may also restrict domains).\n`;
  }

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP forward proxying (absolute-form request target).
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("SCAD egress: expected an absolute http:// URL\n");
      return;
    }
    const policy = await policyFor(req.socket);
    const port = url.port ? Number(url.port) : 80;
    const host = normalizeHost(url.hostname.replace(/^\[|\]$/g, ""));
    if (url.protocol !== "http:") {
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end(deny(policy?.appId, host, "only http:// may be forwarded; use CONNECT for https"));
      return;
    }
    const verdict = await vet(policy, host, port, HTTP_PORTS);
    if ("reason" in verdict || !policy) {
      const reason = "reason" in verdict ? verdict.reason : "unknown source";
      res.writeHead(403, { "content-type": "text/plain" }).end(deny(policy?.appId, host, reason));
      return;
    }
    const release = track(policy.appId);
    if (!release) {
      res.writeHead(429, { "content-type": "text/plain" }).end("SCAD egress: too many connections\n");
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers,
      createConnection: () => dial(verdict.ip, port),
      timeout: CONNECT_TIMEOUT_MS,
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("SCAD egress: upstream failed\n");
    });
    upstream.on("close", release);
    req.pipe(upstream);
    log(`egress allow app=${policy.appId} host=${host} port=${port}`);
  });

  server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const target = parseTarget(req.url ?? "");
    const policy = await policyFor(client);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const verdict = await vet(policy, target.host, target.port, CONNECT_PORTS);
    if ("reason" in verdict || !policy) {
      const body = deny(policy?.appId, target.host, "reason" in verdict ? verdict.reason : "unknown source");
      client.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      return;
    }
    const release = track(policy.appId);
    if (!release) {
      client.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }
    const upstream = dial(verdict.ip, target.port);
    upstream.setTimeout(CONNECT_TIMEOUT_MS);
    upstream.once("connect", () => {
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      client.setTimeout(IDLE_TIMEOUT_MS);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      log(`egress allow app=${policy.appId} host=${target.host} port=${target.port}`);
    });
    const close = () => {
      release();
      upstream.destroy();
      client.destroy();
    };
    upstream.on("timeout", close);
    client.on("timeout", close);
    upstream.on("error", () => {
      if (!client.destroyed && client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      release();
    });
    upstream.on("close", close);
    client.on("close", close);
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  return server;
}

function main(): void {
  const policyDir = process.env["EGRESS_POLICY_DIR"] ?? "/policy";
  const operatorAllow = parseOperatorAllow(process.env["EGRESS_ALLOWED_DOMAINS"]);
  const port = Number(process.env["PORT"] ?? 3128);
  console.log(describeOperatorPolicy(operatorAllow));
  createEgressProxy({ policyDir, operatorAllow }).listen(port, "0.0.0.0", () => {
    console.log(`egress proxy listening on :${port}`);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
