import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DockerRuntimeProvider } from "@scad/runtime-docker";
import { newId } from "@scad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const docker = (...args: string[]) => execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });

/** apps/egress-proxy, independent of the working directory vitest runs from. */
const PROXY_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/egress-proxy");

const APP_IMAGE = "scad-test/egress-app:1";
const APP_DOCKERFILE = [
  "FROM node:22-alpine",
  "USER node",
  `CMD ["node", "-e", "require('http').createServer((q, r) => r.end('ok')).listen(8080)"]`,
  "",
].join("\n");

/** Runs inside the app: CONNECT through $HTTPS_PROXY and print the proxy's status code. */
const CONNECT_PROBE = `
const target = process.argv[1];
const proxy = new URL(process.env.HTTPS_PROXY || "http://missing:1");
const s = require("net").connect(Number(proxy.port), proxy.hostname, () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
s.setTimeout(8000, () => { console.log("STATUS=timeout"); process.exit(0); });
s.on("error", (e) => { console.log("STATUS=error:" + e.code); process.exit(0); });
s.once("data", (d) => { console.log("STATUS=" + d.toString().split(" ")[1]); process.exit(0); });
`;

/** Runs inside the app: try a direct TCP connection, bypassing the proxy. */
const DIRECT_PROBE = `
const [h, p] = process.argv[1].split(":");
const s = require("net").connect(Number(p), h, () => { console.log("DIRECT=open"); process.exit(0); });
s.setTimeout(3000, () => { console.log("DIRECT=timeout"); process.exit(0); });
s.on("error", (e) => { console.log("DIRECT=" + e.code); process.exit(0); });
`;

async function internetAvailable(): Promise<boolean> {
  try {
    const { address } = await lookup("example.com");
    return await new Promise((resolve) => {
      const s = net.connect(443, address, () => {
        s.destroy();
        resolve(true);
      });
      s.setTimeout(3000, () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

/**
 * INV1 + INV2 (T2.1): apps reach the outside world only through the egress
 * proxy, and only to domains both their manifest and the operator allow.
 */
describe("egress proxy and network policy (INV1, INV2, real Docker)", () => {
  const suffix = randomUUID().slice(0, 8);
  const proxyName = `scad-egress-test-${suffix}`;
  const extNet = `scad-egress-ext-test-${suffix}`;
  const appA = newId();
  const appB = newId();
  let policyDir: string;
  let provider: DockerRuntimeProvider;
  let containerA = "";
  let containerB = "";
  let ipB = "";
  let online = false;

  const connectFrom = async (container: string, target: string) => {
    const { stdout } = await docker("exec", container, "node", "-e", CONNECT_PROBE, target);
    return /STATUS=(\S+)/.exec(stdout)?.[1] ?? stdout.trim();
  };

  beforeAll(async () => {
    online = await internetAvailable();
    policyDir = await mkdtemp(join(tmpdir(), "scad-egress-policy-"));
    await docker("build", "-q", "-t", `scad-test/egress-proxy:${suffix}`, "-f", join(PROXY_DIR, "Dockerfile"), PROXY_DIR);
    await execFileAsync("sh", ["-c", `printf '%s' "$DF" | docker build -q --network=none -t ${APP_IMAGE} -`], {
      env: { ...process.env, DF: APP_DOCKERFILE },
    });
    await docker("network", "create", extNet);
    await docker(
      "run", "-d", "--name", proxyName, "--network", extNet,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "-v", `${policyDir}:/policy:ro`,
      "-e", "EGRESS_POLICY_DIR=/policy",
      "-e", "EGRESS_ALLOWED_DOMAINS=example.com,localtest.me",
      `scad-test/egress-proxy:${suffix}`,
    );

    provider = new DockerRuntimeProvider({
      gatewayContainerName: null,
      egressProxyContainerName: proxyName,
      egressPolicyDir: policyDir,
    });
    const spec = (appId: string, egressAllow: string[]) => ({
      appId,
      imageRef: APP_IMAGE,
      port: 8080,
      env: {},
      egressAllow,
      limits: { memoryMb: 128, cpuShares: 1024, diskGb: 1, pids: 64 },
    });
    const a = await provider.deploy(spec(appA, ["example.com", "localtest.me"]));
    const b = await provider.deploy(spec(appB, []));
    containerA = a.providerId;
    containerB = b.providerId;
    ipB = (await provider.address(b)).host;
    await new Promise((r) => setTimeout(r, 1500)); // the proxy reloads policy every second
  }, 300_000);

  afterAll(async () => {
    await provider?.remove(appA, { deleteVolume: true }).catch(() => undefined);
    await provider?.remove(appB, { deleteVolume: true }).catch(() => undefined);
    await docker("rm", "-f", proxyName).catch(() => undefined);
    await docker("network", "rm", extNet).catch(() => undefined);
    await docker("image", "rm", "-f", `scad-test/egress-proxy:${suffix}`).catch(() => undefined);
    await rm(policyDir, { recursive: true, force: true });
  }, 120_000);

  it("the app gets proxy env and the driver writes its policy (subnet + allowlist)", async () => {
    const { stdout } = await docker("exec", containerA, "sh", "-c", "echo $HTTPS_PROXY $HTTP_PROXY");
    expect(stdout.trim()).toBe(`http://${proxyName}:3128 http://${proxyName}:3128`);
    const policy = JSON.parse(await readFile(join(policyDir, `${appA}.json`), "utf8"));
    expect(policy).toMatchObject({ appId: appA, allow: ["example.com", "localtest.me"] });
    expect(policy.subnet).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
  });

  it.each([
    ["cloud metadata", "169.254.169.254:80"],
    ["the host (Docker Desktop alias)", "host.docker.internal:5432"],
    ["the host gateway IP", `${process.env["SCAD_HOST_GATEWAY_IP"] ?? "172.17.0.1"}:5432`],
    ["the control plane", "host.docker.internal:4000"],
    ["the Docker API port", "host.docker.internal:2375"],
    ["an undeclared domain", "github.com:443"],
  ])("refuses %s through the proxy (403)", async (_label, target) => {
    expect(await connectFrom(containerA, target)).toBe("403");
  });

  it("refuses another app's address through the proxy", async () => {
    expect(await connectFrom(containerA, `${ipB}:8080`)).toBe("403");
  });

  it("an app with no egress declared gets nothing, even for a domain another app may use", async () => {
    expect(await connectFrom(containerB, "example.com:443")).toBe("403");
  });

  it("direct connections without the proxy still go nowhere (no default route)", async () => {
    for (const target of ["1.1.1.1:443", "169.254.169.254:80", `${ipB}:8080`]) {
      const { stdout } = await docker("exec", containerA, "node", "-e", DIRECT_PROBE, target);
      expect(stdout).not.toContain("DIRECT=open");
    }
  });

  it("an allowed domain works (needs internet on this machine)", async (ctx) => {
    if (!online) ctx.skip();
    expect(await connectFrom(containerA, "example.com:443")).toBe("200");
  });

  it("DNS rebinding: an allowed name that resolves to loopback is refused (needs public DNS)", async (ctx) => {
    if (!online) ctx.skip();
    // localtest.me is public DNS that answers 127.0.0.1.
    expect(await connectFrom(containerA, "localtest.me:443")).toBe("403");
  });
});
