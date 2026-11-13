import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** T3.1: the production stack exposes only Caddy and never fakes auth. */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
/** File contents with whole-line `#` comments removed. */
const read = (path: string) =>
  readFileSync(join(root, path), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Each service's block of deploy/compose.yml, by name (two-space indent). */
function services(compose: string): Map<string, string> {
  const body = compose.split(/^services:\n/m)[1]?.split(/^\S/m)[0] ?? "";
  const out = new Map<string, string>();
  for (const block of body.split(/^(?= {2}[a-z][\w-]*:\n)/m)) {
    const name = block.match(/^ {2}([a-z][\w-]*):/)?.[1];
    if (name) out.set(name, block);
  }
  return out;
}

describe("deploy/compose.yml", () => {
  const compose = read("deploy/compose.yml");
  const byName = services(compose);

  it("has the production services", () => {
    expect([...byName.keys()].sort()).toEqual(["caddy", "egress-proxy", "gateway", "postgres"]);
  });

  it("publishes 80/443 only on Caddy, and Postgres only on loopback", () => {
    for (const [name, block] of byName) {
      const ports = block.split(/\n {4}ports:\n/)[1]?.split(/\n {4}\S/)[0] ?? "";
      const published = [...ports.matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
      if (name === "caddy") expect(published).toEqual(["80:80", "443:443", "443:443/udp"]);
      else if (name === "postgres") expect(published).toEqual(["127.0.0.1:5432:5432"]);
      else expect(published).toEqual([]);
    }
  });

  it("never runs fake auth and runs the gateway in production mode", () => {
    const gateway = byName.get("gateway") ?? "";
    expect(gateway).toMatch(/GATEWAY_FAKE_AUTH: "0"/);
    expect(gateway).toMatch(/NODE_ENV: production/);
    expect(compose).not.toMatch(/GATEWAY_FAKE_AUTH: \$\{/);
  });

  it("takes every name from BASE_DOMAIN, never localhost", () => {
    expect(compose).not.toMatch(/localhost/);
    expect(byName.get("gateway")).toMatch(/BASE_DOMAIN: \$\{BASE_DOMAIN:\?/);
    expect(byName.get("caddy")).toMatch(/BASE_DOMAIN: \$\{BASE_DOMAIN:\?/);
  });

  it("trusts forwarded IPs only from Caddy's pinned address", () => {
    const ip = byName.get("caddy")?.match(/ipv4_address: ([\d.]+)/)?.[1];
    expect(ip).toBeDefined();
    expect(byName.get("gateway")).toContain(`GATEWAY_TRUST_PROXY: ${ip}`);
  });

  it("requires SMTP from env and keeps the gateway's name for app-network attach", () => {
    expect(byName.get("gateway")).toMatch(/SMTP_URL: \$\{SMTP_URL:\?/);
    expect(byName.get("gateway")).toMatch(/container_name: scad-gateway/);
    expect(byName.get("egress-proxy")).toMatch(/container_name: scad-egress/);
  });
});

describe("deploy/Caddyfile", () => {
  const caddy = read("deploy/Caddyfile");

  it("issues certificates on demand only after asking the control plane", () => {
    expect(caddy).toMatch(/on_demand_tls \{\s*ask \{\$TLS_ASK_URL\}/);
    expect(caddy).toMatch(/tls \{\s*on_demand\s*\}/);
  });

  it("routes api.{BASE_DOMAIN} to the control plane and hides /internal", () => {
    expect(caddy).toMatch(/@api host api\.\{\$BASE_DOMAIN\}/);
    expect(caddy).toMatch(/respond @internal 404/);
  });

  it("does not trust visitor-supplied X-Forwarded-For", () => {
    expect(caddy).not.toMatch(/trusted_proxies/);
  });
});

describe("dev docker-compose.yml", () => {
  it("takes BASE_DOMAIN from env (localhost by default)", () => {
    expect(read("docker-compose.yml")).toMatch(/BASE_DOMAIN: \$\{BASE_DOMAIN:-localhost:8080\}/);
  });
});

describe("deploy/systemd/scad-builder.service", () => {
  it("keeps temp files where the Docker daemon can see them (fetch bind-mounts its workspace)", () => {
    const unit = read("deploy/systemd/scad-builder.service");
    const tmpdir = unit.match(/^Environment=TMPDIR=(\S+)$/m)?.[1];
    if (/^PrivateTmp=true$/m.test(unit)) {
      expect(tmpdir, "PrivateTmp hides /tmp and /var/tmp from dockerd; set TMPDIR elsewhere").toBeDefined();
      expect(tmpdir!.startsWith("/tmp") || tmpdir!.startsWith("/var/tmp")).toBe(false);
    }
  });
});
