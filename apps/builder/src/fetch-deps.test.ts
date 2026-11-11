import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_SECRET_ENV } from "./docker-build.js";
import {
  FetchError,
  fetchNodeDependencies,
  fetchRunArgs,
  NPM_FETCH_SCRIPT,
  npmFetchEnv,
  nonRegistrySources,
  nonRegistrySpecs,
  packagesWithInstallScripts,
  runInFetchSandbox,
  safeNpmrcEnv,
  type ExecFn,
} from "./fetch-deps.js";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-fetch-test-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const secrets = Object.fromEntries(PLATFORM_SECRET_ENV.map((k) => [k, `secret-${k}`]));

/** Fake docker CLI: records calls, answers inspect/network commands. */
function fakeDocker(onRun?: (args: string[]) => Promise<void> | void): { exec: ExecFn; calls: { args: string[]; env: NodeJS.ProcessEnv }[] } {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: ExecFn = async (_file, args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === "inspect") return { stdout: "true\n", stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") return { stdout: "172.31.0.0/16 fd00::/64 \n", stderr: "" };
    if (args[0] === "run") await onRun?.(args);
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("fetch sandbox (T3.2 trusted dependency fetch)", () => {
  it("docker run: hardened, only the work dir mounted, only the fetch network, no secrets", () => {
    const args = fetchRunArgs({
      name: "scad-fetch-1",
      network: "scad-fetch-1",
      workDir: "/tmp/w",
      image: "node:22-alpine",
      env: npmFetchEnv("http://scad-egress:3128"),
      argv: ["sh", "-ec", NPM_FETCH_SCRIPT],
      user: "1000:1000",
    });
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000"]));
    expect(args[args.indexOf("--network") + 1]).toBe("scad-fetch-1");
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
    expect(args[args.indexOf("-v") + 1]).toBe("/tmp/w:/work");
    expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--network=host|host-gateway/);
    for (const key of PLATFORM_SECRET_ENV) expect(args.join(" ")).not.toContain(key);
  });

  it("npm runs against the registry, through the proxy, with install scripts off", () => {
    const env = npmFetchEnv("http://scad-egress:3128");
    expect(env).toMatchObject({
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_https_proxy: "http://scad-egress:3128",
      npm_config_ignore_scripts: "true",
    });
    expect(NPM_FETCH_SCRIPT).toContain("npm ci --include=dev --include=optional --ignore-scripts");
    expect(NPM_FETCH_SCRIPT).toContain("npm install --package-lock-only --ignore-scripts");
    expect(NPM_FETCH_SCRIPT).not.toMatch(/npm (run|rebuild|exec)|npx/);
  });

  it("allows only the registry host, gives docker no platform secrets, and always cleans up", async () => {
    const policyDir = await fixture({});
    let policy: unknown;
    const { exec, calls } = fakeDocker(async () => {
      const files = (await import("node:fs/promises")).readdir(policyDir);
      const [file] = await files;
      policy = JSON.parse(await readFile(join(policyDir, file!), "utf8"));
    });
    const out = await runInFetchSandbox(
      { workDir: "/tmp/w", image: "node:22-alpine", allow: ["registry.npmjs.org"], env: {}, argv: ["true"] },
      { exec, policyDir, parentEnv: { PATH: "/bin", ...secrets } },
    );
    expect(out.ok).toBe(true);
    expect(policy).toMatchObject({ subnet: "172.31.0.0/16", allow: ["registry.npmjs.org"] });
    expect(calls.find((c) => c.args[0] === "network" && c.args[1] === "create")?.args).toContain("--internal");
    for (const c of calls) expect(c.env).toEqual({ PATH: "/bin" });
    const verbs = calls.map((c) => c.args.slice(0, 2).join(" "));
    expect(verbs).toEqual(expect.arrayContaining(["rm -f", "network disconnect", "network rm"]));
    expect(await (await import("node:fs/promises")).readdir(policyDir)).toEqual([]);
  });

  it("refuses to run (with an operator hint) when the egress proxy is down", async () => {
    const exec: ExecFn = async (_f, args) => {
      if (args[0] === "inspect") throw new Error("No such object: scad-egress");
      return { stdout: "", stderr: "" };
    };
    const err = await runInFetchSandbox({ workDir: "/w", image: "x", allow: [], env: {}, argv: [] }, { exec }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).envelope.hint).toMatch(/egress proxy/);
  });
});

describe("registry-only sources", () => {
  it("lockfile entries from another host, git, or plain http are refused", () => {
    expect(
      nonRegistrySources({
        packages: {
          "": { name: "app" },
          "node_modules/ok": { resolved: "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz" },
          "node_modules/evil": { resolved: "https://evil.example/evil-1.0.0.tgz" },
          "node_modules/plain": { resolved: "http://registry.npmjs.org/plain/-/plain-1.0.0.tgz" },
          "node_modules/gitdep": { resolved: "git+ssh://git@github.com/x/y.git#abc" },
          "node_modules/linked": { link: true, resolved: "packages/linked" },
        },
      }),
    ).toEqual([
      "evil -> https://evil.example/evil-1.0.0.tgz",
      "plain -> http://registry.npmjs.org/plain/-/plain-1.0.0.tgz",
      "gitdep -> git+ssh://git@github.com/x/y.git#abc",
    ]);
  });

  it("package.json specs that are git, URLs, or local paths are refused", () => {
    expect(
      nonRegistrySpecs({
        dependencies: { react: "^19.0.0", a: "github:x/y", b: "https://evil.example/b.tgz", c: "file:../c", d: "x/y#main" },
        devDependencies: { vite: "8.0.0", e: "git+https://github.com/x/e.git" },
      }),
    ).toHaveLength(5);
  });

  it("fetchNodeDependencies refuses a lockfile pointing at a non-registry host before downloading", async () => {
    const dir = await fixture({
      "package.json": JSON.stringify({ dependencies: { evil: "1.0.0" } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/evil": { version: "1.0.0", resolved: "https://evil.example/evil.tgz" } },
      }),
    });
    const { exec, calls } = fakeDocker();
    const err = (await fetchNodeDependencies(dir, { exec }).catch((e: unknown) => e)) as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.envelope).toMatchObject({ code: "BUILD_FAILED", hint: expect.stringContaining("evil.example") });
    expect(calls.some((c) => c.args[0] === "run")).toBe(false);
  });

  it("only harmless .npmrc keys are honoured (never registry, auth, or scripts)", async () => {
    const dir = await fixture({
      ".npmrc": "legacy-peer-deps=true\nregistry=https://evil.example/\nignore-scripts=false\n//evil.example/:_authToken=x\n",
    });
    expect(await safeNpmrcEnv(dir)).toEqual({ npm_config_legacy_peer_deps: "true" });
  });
});

describe("install script report", () => {
  it("names installed packages with install scripts or native addons", async () => {
    const dir = await fixture({
      "esbuild/package.json": JSON.stringify({ name: "esbuild", scripts: { postinstall: "node install.js" } }),
      "@scope/native/package.json": JSON.stringify({ name: "@scope/native" }),
      "@scope/native/binding.gyp": "{}",
      "plain/package.json": JSON.stringify({ name: "plain", scripts: { test: "x" } }),
      "plain/node_modules/inner/package.json": JSON.stringify({ name: "inner", scripts: { preinstall: "x" } }),
    });
    expect(await packagesWithInstallScripts(dir)).toEqual(["@scope/native", "esbuild", "inner"]);
  });
});
