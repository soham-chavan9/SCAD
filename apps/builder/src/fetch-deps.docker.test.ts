import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FETCH_NODE_IMAGE, fetchNodeDependencies, npmFetchEnv, runInFetchSandbox } from "./fetch-deps.js";

const execFileAsync = promisify(execFile);

/** Real Docker + the egress proxy + the npm registry; skipped when any is missing. */
async function available(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", "scad-egress"]);
    if (stdout.trim() !== "true") return false;
    const res = await fetch("https://registry.npmjs.org/is-number", { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
const ready = await available();
if (!ready) console.warn("skipping fetch sandbox tests: needs Docker, scad-egress, and registry.npmjs.org");

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe.runIf(ready)("trusted fetch on real Docker (T3.2)", () => {
  it("installs a registry dependency but never runs install scripts (postinstall does not run)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-fetch-real-"));
    try {
      const marker = (event: string) => `mkdir -p node_modules && touch node_modules/PWNED-${event}`;
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fetch-scripts",
          version: "1.0.0",
          scripts: {
            preinstall: marker("preinstall"),
            install: marker("install"),
            postinstall: marker("postinstall"),
            prepare: marker("prepare"),
          },
          dependencies: { "is-number": "7.0.0" },
        }),
      );
      const result = await fetchNodeDependencies(dir);
      expect(await exists(join(dir, "node_modules", "is-number", "package.json"))).toBe(true);
      const names = await readdir(join(dir, "node_modules"));
      expect(names.filter((n) => n.startsWith("PWNED"))).toEqual([]);
      expect(await exists(join(dir, "package-lock.json"))).toBe(true); // resolved with --package-lock-only
      expect(result.skippedInstallScripts).toEqual([]);

      // Positive control: the same package with scripts on does write the markers.
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
      const control = await runInFetchSandbox({
        workDir: dir,
        image: FETCH_NODE_IMAGE,
        allow: ["registry.npmjs.org"],
        env: { ...npmFetchEnv("http://scad-egress:3128"), npm_config_ignore_scripts: "false" },
        argv: ["npm", "install", "--foreground-scripts"],
      });
      expect(control.ok, control.log).toBe(true);
      expect((await readdir(join(dir, "node_modules"))).filter((n) => n.startsWith("PWNED")).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("reaches the npm registry through the proxy, and nothing else (proxy refuses, no direct route or DNS)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-fetch-net-"));
    try {
      const probe = `
        const http = require("node:http"), net = require("node:net"), dns = require("node:dns/promises");
        const connect = (host) => new Promise((done) => {
          const req = http.request({ host: "scad-egress", port: 3128, method: "CONNECT", path: host + ":443" });
          req.on("connect", (res, socket) => { socket.destroy(); done(res.statusCode); });
          req.on("response", (res) => done(res.statusCode));
          req.on("error", (e) => done("error " + e.code));
          req.end();
        });
        const direct = () => new Promise((done) => {
          const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
          s.on("connect", () => { s.destroy(); done("connected"); });
          s.on("timeout", () => { s.destroy(); done("blocked"); });
          s.on("error", () => done("blocked"));
        });
        (async () => {
          const out = {
            registry: await connect("registry.npmjs.org"),
            other: await connect("example.com"),
            github: await connect("github.com"),
            metadata: await connect("169.254.169.254"),
            direct: await direct(),
            dns: await dns.lookup("example.com").then(() => "resolved", () => "failed"),
          };
          console.log("PROBE " + JSON.stringify(out));
        })();`;
      const run = await runInFetchSandbox({
        workDir: dir,
        image: FETCH_NODE_IMAGE,
        allow: ["registry.npmjs.org"],
        env: { HOME: "/tmp" },
        argv: ["node", "-e", probe],
      });
      expect(run.ok, run.log).toBe(true);
      const line = run.log.split("\n").find((l) => l.startsWith("PROBE "));
      const out = JSON.parse(line!.slice(6)) as Record<string, unknown>;
      expect(out).toEqual({ registry: 200, other: 403, github: 403, metadata: 403, direct: "blocked", dns: "failed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
