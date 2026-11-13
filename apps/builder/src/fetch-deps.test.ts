import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_SECRET_ENV } from "./docker-build.js";
import {
  assertSafeFetchedTree,
  copyFetchedFile,
  FetchError,
  fetchNodeDependencies,
  fetchRubyGems,
  fetchRunArgs,
  FONT_FETCH_SCRIPT,
  NPM_FETCH_SCRIPT,
  NPM_RELOCK_FETCH_SCRIPT,
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

describe("SCAD-added dependencies and fonts (T3.3)", () => {
  it("adds a pinned adapter to the build copy, re-resolves the lockfile, and passes fonts as argv (never shell text)", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ name: "kit", devDependencies: { "@sveltejs/kit": "3.2.0" } }) });
    const runs: string[][] = [];
    const { exec } = fakeDocker(async (args) => {
      runs.push(args);
      const work = args[args.indexOf("-v") + 1]!.split(":/work")[0]!;
      const fs = await import("node:fs/promises");
      if (args.includes(NPM_RELOCK_FETCH_SCRIPT)) {
        const pkg = JSON.parse(await fs.readFile(join(work, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        expect(pkg.dependencies).toEqual({ "@sveltejs/adapter-node": "6.0.2" });
        await fs.writeFile(join(work, "package-lock.json"), "{}");
        await fs.mkdir(join(work, "node_modules"), { recursive: true });
      }
    });
    await fetchNodeDependencies(dir, {
      exec,
      policyDir: await fixture({}),
      extraDependencies: { "@sveltejs/adapter-node": "6.0.2" },
      googleFonts: ["geist", "geist-mono", "bad;rm"],
    });
    expect(runs[0]).toContain(NPM_RELOCK_FETCH_SCRIPT);
    const fontRun = runs.find((a) => a.includes(FONT_FETCH_SCRIPT))!;
    expect(fontRun.slice(fontRun.indexOf(FONT_FETCH_SCRIPT) + 1)).toEqual(["scad-fonts", "geist", "geist-mono"]);
    // The build copy (not the founder's folder) now lists the adapter.
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).dependencies).toEqual({ "@sveltejs/adapter-node": "6.0.2" });
  });

  it("refuses an extra dependency that is not a plain pinned registry package", async () => {
    const dir = await fixture({ "package.json": "{}" });
    await expect(fetchNodeDependencies(dir, { exec: fakeDocker().exec, extraDependencies: { "x; rm -rf /": "1.0.0" } })).rejects.toThrow(/invalid extra/);
    await expect(fetchNodeDependencies(dir, { exec: fakeDocker().exec, extraDependencies: { x: "^1" } })).rejects.toThrow(/invalid extra/);
  });
});


describe("fetch output is checked on the host (INV8: no secrets through links)", () => {
  const workOf = (args: string[]) => args[args.indexOf("-v") + 1]!.split(":/work")[0]!;

  it("a Gemfile that swaps Gemfile.lock for a link to the host .env is refused, and the secret is not copied", async () => {
    const host = await fixture({ ".env": "MASTER_KEY=host-secret" });
    const ctx = await fixture({ Gemfile: 'source "https://rubygems.org"\ngem "jekyll"\n' });
    const { exec } = fakeDocker(async (args) => {
      const work = workOf(args);
      await mkdir(join(work, "vendor", "cache"), { recursive: true });
      await writeFile(join(work, "vendor", "cache", "jekyll-4.4.1.gem"), "gem");
      await rm(join(work, "Gemfile.lock"), { force: true });
      await symlink(join(host, ".env"), join(work, "Gemfile.lock"));
    });
    const err = (await fetchRubyGems(ctx, { exec, policyDir: await fixture({}) }).catch((e: unknown) => e)) as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.envelope.code).toBe("BUILD_FAILED");
    const lock = await readFile(join(ctx, "Gemfile.lock"), "utf8").catch(() => "");
    expect(lock).not.toContain("host-secret");
  });

  it("a gem cache that is a link out of the workspace is refused before anything is moved", async () => {
    const host = await fixture({ "secret/key": "host-secret" });
    const ctx = await fixture({ Gemfile: 'source "https://rubygems.org"\n' });
    const { exec } = fakeDocker(async (args) => {
      const work = workOf(args);
      await writeFile(join(work, "Gemfile.lock"), "GEM\n");
      await mkdir(join(work, "vendor"), { recursive: true });
      await symlink(join(host, "secret"), join(work, "vendor", "cache"));
    });
    await expect(fetchRubyGems(ctx, { exec, policyDir: await fixture({}) })).rejects.toBeInstanceOf(FetchError);
    expect(await readFile(join(host, "secret", "key"), "utf8")).toBe("host-secret");
    await expect(readFile(join(ctx, "vendor", "cache", "key"), "utf8")).rejects.toThrow();
  });

  it("node_modules: relative links inside are fine; absolute or escaping links are refused", async () => {
    const ok = await fixture({ "vite/bin/vite.js": "x" });
    await mkdir(join(ok, ".bin"));
    await symlink("../vite/bin/vite.js", join(ok, ".bin", "vite"));
    await expect(assertSafeFetchedTree(ok, { allowLinks: true })).resolves.toBeUndefined();

    const abs = await fixture({ "a/package.json": "{}" });
    await symlink("/etc/passwd", join(abs, "a", "leak"));
    await expect(assertSafeFetchedTree(abs, { allowLinks: true })).rejects.toBeInstanceOf(FetchError);

    const up = await fixture({ "a/package.json": "{}" });
    await symlink("../../outside", join(up, "a", "leak"));
    await expect(assertSafeFetchedTree(up, { allowLinks: true })).rejects.toBeInstanceOf(FetchError);

    await expect(assertSafeFetchedTree(ok, { allowLinks: false })).rejects.toBeInstanceOf(FetchError);
  });

  it("copyFetchedFile copies regular files and refuses a link on either end", async () => {
    const d = await fixture({ "src.txt": "hello", "secret.txt": "host-secret" });
    await copyFetchedFile(join(d, "src.txt"), join(d, "out.txt"));
    expect(await readFile(join(d, "out.txt"), "utf8")).toBe("hello");

    await symlink(join(d, "secret.txt"), join(d, "link.txt"));
    await expect(copyFetchedFile(join(d, "link.txt"), join(d, "out2.txt"))).rejects.toBeInstanceOf(FetchError);

    await expect(copyFetchedFile(join(d, "src.txt"), join(d, "big.txt"), 4)).rejects.toThrow(/larger than/);

    await symlink(join(d, "secret.txt"), join(d, "dst-link.txt"));
    await copyFetchedFile(join(d, "src.txt"), join(d, "dst-link.txt"));
    expect(await readFile(join(d, "secret.txt"), "utf8")).toBe("host-secret");
  });
});
