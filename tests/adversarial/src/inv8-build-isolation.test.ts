import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { dockerBuild } from "@scad/builder";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * INV8: a RUN step in an uploaded Dockerfile cannot reach the control plane,
 * Postgres, Mailpit, the host, or the internet.
 *
 * The probe tries every target and prints `HIT=<target>` for each TCP
 * handshake that succeeds. A control build on the default network proves the
 * probe works (Postgres from docker compose must be reachable there).
 */
function hostGatewayIp(): string {
  return process.env["SCAD_HOST_GATEWAY_IP"] ?? "172.17.0.1";
}

function targets(): string[] {
  const gw = hostGatewayIp();
  const ports = [4000, 5432, 1025, 8025, 8080]; // control plane, Postgres, Mailpit SMTP/UI, gateway
  return [
    ...ports.map((p) => `host.docker.internal:${p}`), // Docker Desktop host alias
    ...ports.map((p) => `${gw}:${p}`), // Linux bridge gateway (the host)
    "169.254.169.254:80", // cloud metadata
    "1.1.1.1:443", // internet
    "8.8.8.8:53",
  ];
}

function probeDockerfile(): string {
  // `HIT=` is assembled from two parts so BuildKit's echo of the RUN command
  // never matches the result pattern.
  const loop = targets()
    .map((t) => {
      const [h, p] = t.split(":");
      return `if nc -z -w 2 ${h} ${p} 2>/dev/null; then echo "HI""T=${t}"; fi`;
    })
    .join("; ");
  return [
    "FROM busybox:1.36",
    // Changes every run so the RUN step is never served from cache.
    "COPY nonce /nonce",
    `RUN ${loop}; if nslookup example.com >/dev/null 2>&1; then echo "HI""T=dns"; fi; echo "PROBE""_DONE"`,
    "USER 65534",
    "",
  ].join("\n");
}

async function writeContext(root: string): Promise<string> {
  const dir = await mkdtemp(join(root, "ctx-"));
  await writeFile(join(dir, "Dockerfile"), probeDockerfile());
  await writeFile(join(dir, "nonce"), randomUUID());
  return dir;
}

function hits(log: string): string[] {
  return [...new Set([...log.matchAll(/HIT=(\S+)/g)].map((m) => m[1] ?? ""))];
}

describe("INV8: build isolation (real Docker)", () => {
  let root: string;
  const images: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "scad-inv8-"));
    await execFileAsync("docker", ["pull", "-q", "busybox:1.36"]);
  }, 120_000);

  afterAll(async () => {
    for (const ref of images) {
      await execFileAsync("docker", ["image", "rm", "-f", ref]).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("control: the probe reaches Postgres when built on the default network", async () => {
    const ctx = await writeContext(root);
    const imageRef = `scad-test/inv8-control:${randomUUID().slice(0, 8)}`;
    images.push(imageRef);
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["build", "--progress=plain", "-t", imageRef, ctx],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    const log = `${stdout}\n${stderr}`;
    expect(log).toContain("PROBE_DONE");
    const reached = hits(log);
    expect(
      reached.some((t) => t.endsWith(":5432")),
      `control build should reach Postgres, or the probe proves nothing; reached=${reached.join(",")}`,
    ).toBe(true);
  }, 180_000);

  it("a RUN step built by the SCAD builder reaches nothing", async () => {
    const ctx = await writeContext(root);
    const imageRef = `scad-test/inv8-isolated:${randomUUID().slice(0, 8)}`;
    images.push(imageRef);
    const result = await dockerBuild({ contextDir: ctx, imageRef });
    expect(result.ok, result.log).toBe(true);
    expect(result.log).toContain("PROBE_DONE");
    expect(hits(result.log)).toEqual([]);
  }, 180_000);
});
