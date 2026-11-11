import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { makeError, type ErrorEnvelope } from "@scad/shared";
import { buildEnv } from "./docker-build.js";

const execFileAsync = promisify(execFile);

/**
 * T3.2 trusted dependency fetch (Blocked option c).
 *
 * Builds stay `--network=none` (INV8). Before the build, a separate,
 * locked-down container downloads the app's declared dependencies:
 *
 * - it sees only the dependency manifests (package.json + lockfile, or
 *   Gemfile + Gemfile.lock), never the app's source or any platform secret;
 * - its only network is a private `internal` Docker network whose one exit is
 *   the egress proxy, with a policy that allows the package registry and
 *   nothing else (the proxy resolves DNS itself and blocks private ranges);
 * - install scripts are off (`npm ci --ignore-scripts`, `bundle cache
 *   --no-install`), so no package code runs while the network is reachable;
 * - non-root, read-only root, all capabilities dropped, memory/pids capped,
 *   killed after {@link FETCH_LIMITS.timeoutMs}; output size is capped.
 *
 * The fetched `node_modules/` (or `vendor/cache/`) is then moved into the
 * build context, and the offline build uses it.
 */

export const NPM_REGISTRY_HOST = "registry.npmjs.org";
export const NPM_REGISTRY = `https://${NPM_REGISTRY_HOST}/`;
export const RUBYGEMS_HOSTS = ["rubygems.org", "index.rubygems.org"] as const;

export const FETCH_NODE_IMAGE = "node:22-alpine";
export const FETCH_RUBY_IMAGE = "ruby:3.3";

export const FETCH_LIMITS = {
  timeoutMs: Number(process.env["SCAD_FETCH_TIMEOUT_MS"] ?? 5 * 60 * 1000),
  maxBytes: Number(process.env["SCAD_FETCH_MAX_MB"] ?? 1536) * 1024 * 1024,
  memoryMb: 2048,
  pids: 512,
} as const;

const EGRESS_PROXY_PORT = 3128;

export class FetchError extends Error {
  readonly envelope: ErrorEnvelope;
  readonly log: string;
  constructor(message: string, hint: string, details: Record<string, unknown> = {}, log = "") {
    super(message);
    this.name = "FetchError";
    this.envelope = makeError("BUILD_FAILED", message, hint, details);
    this.log = log;
  }
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

export type FetchOptions = {
  /** Egress proxy container (shared with apps). Default `scad-egress`. */
  proxyContainer?: string;
  /** Where the proxy reads policies. Default `$SCAD_EGRESS_POLICY_DIR` or `~/.scad/egress-policy`. */
  policyDir?: string;
  exec?: ExecFn;
  parentEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  log?: (line: string) => void;
};

function policyDirOf(opts: FetchOptions): string {
  return opts.policyDir ?? process.env["SCAD_EGRESS_POLICY_DIR"] ?? join(homedir(), ".scad", "egress-policy");
}

function proxyOf(opts: FetchOptions): string {
  return opts.proxyContainer ?? process.env["SCAD_FETCH_PROXY_CONTAINER"] ?? "scad-egress";
}

/**
 * `docker run` argv for the fetch container. Pure, so tests can check that no
 * platform secret, host path other than the work dir, or extra network is
 * ever passed. `env` keys and values are fixed by SCAD, never taken from the app.
 */
export function fetchRunArgs(o: {
  name: string;
  network: string;
  workDir: string;
  image: string;
  env: Record<string, string>;
  argv: string[];
  user?: string | undefined;
}): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    o.name,
    "--network",
    o.network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    `${FETCH_LIMITS.memoryMb}m`,
    "--memory-swap",
    `${FETCH_LIMITS.memoryMb}m`,
    "--pids-limit",
    String(FETCH_LIMITS.pids),
    "--label",
    "scad.role=fetch",
    "-v",
    `${o.workDir}:/work`,
    "-w",
    "/work",
  ];
  if (o.user) args.push("--user", o.user);
  for (const [k, v] of Object.entries(o.env)) args.push("-e", `${k}=${v}`);
  args.push(o.image, ...o.argv);
  return args;
}

/** Environment for npm inside the fetch container: registry via the proxy, scripts off. */
export function npmFetchEnv(proxyUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: "/tmp",
    npm_config_cache: "/tmp/.npm",
    npm_config_userconfig: "/tmp/.npmrc-none",
    npm_config_registry: NPM_REGISTRY,
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_progress: "false",
    npm_config_loglevel: "warn",
    ...extra,
  };
}

/**
 * The fixed npm script run in the fetch container (no app input is ever
 * interpolated). Without a package-lock.json, resolve one first (also with
 * scripts off), then install exactly that lockfile.
 */
export const NPM_FETCH_SCRIPT = [
  "set -e",
  'if [ ! -f package-lock.json ]; then echo "scad-fetch: no package-lock.json, resolving one from package.json"; npm install --package-lock-only --ignore-scripts; fi',
  "npm ci --include=dev --include=optional --ignore-scripts",
].join("\n");

/** Fixed bundler script: lock for this platform and download .gem files only (no install, no extension builds). */
export const BUNDLER_FETCH_SCRIPT = [
  "set -e",
  "export BUNDLE_APP_CONFIG=/tmp/bundle BUNDLE_USER_HOME=/tmp/bundle-home BUNDLE_SILENCE_ROOT_WARNING=1 BUNDLE_DISABLE_VERSION_CHECK=1",
  'PLATFORM="$(ruby -e "print Gem::Platform.local.to_s")"',
  "if [ ! -f Gemfile.lock ]; then bundle lock; fi",
  'bundle lock --add-platform "$PLATFORM"',
  "bundle cache --no-install",
].join("\n");

const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
const OTHER_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"] as const;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function firstFile<T extends string>(dir: string, names: readonly T[]): Promise<T | undefined> {
  for (const n of names) if (await isFile(join(dir, n))) return n;
  return undefined;
}

/**
 * Lockfile entries that would download from anywhere but the npm registry
 * (tarball URLs, git, other hosts). The proxy refuses those hosts anyway;
 * this gives the agent a clear hint first.
 */
export function nonRegistrySources(lock: unknown): string[] {
  const bad: string[] = [];
  if (typeof lock !== "object" || lock === null) return bad;
  const packages = (lock as { packages?: Record<string, { resolved?: unknown; link?: unknown }> }).packages;
  const deps = (lock as { dependencies?: Record<string, { resolved?: unknown }> }).dependencies;
  const check = (name: string, resolved: unknown) => {
    if (typeof resolved !== "string") return;
    let ok = false;
    try {
      const u = new URL(resolved);
      ok = u.protocol === "https:" && u.hostname === NPM_REGISTRY_HOST && u.port === "";
    } catch {
      ok = false;
    }
    if (!ok) bad.push(`${name || "(root)"} -> ${resolved.slice(0, 200)}`);
  };
  if (packages && typeof packages === "object") {
    for (const [path, entry] of Object.entries(packages)) {
      if (path === "" || entry?.link === true) continue; // root and workspace links
      check(path.replace(/^.*node_modules\//, ""), entry?.resolved);
    }
  } else if (deps && typeof deps === "object") {
    for (const [name, entry] of Object.entries(deps)) check(name, entry?.resolved);
  }
  return bad;
}

/** Dependency specs in package.json that are not registry versions (git, URLs, local paths). */
export function nonRegistrySpecs(pkg: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      if (
        /^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|portal:)/i.test(spec) ||
        /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)
      ) {
        bad.push(`${name}: ${spec.slice(0, 200)}`);
      }
    }
  }
  return bad;
}

/** `.npmrc` keys the fetch honours. Everything else (registry, auth, scripts) is ignored. */
const SAFE_NPMRC_KEYS = new Set(["legacy-peer-deps", "strict-peer-deps", "engine-strict"]);

export async function safeNpmrcEnv(dir: string): Promise<Record<string, string>> {
  const path = join(dir, ".npmrc");
  if (!(await isFile(path))) return {};
  const text = (await readFile(path, "utf8")).slice(0, 64 * 1024);
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = /^\s*([a-z-]+)\s*=\s*(true|false)\s*$/.exec(raw);
    if (m?.[1] && m[2] && SAFE_NPMRC_KEYS.has(m[1])) env[`npm_config_${m[1].replace(/-/g, "_")}`] = m[2];
  }
  return env;
}

export type FetchResult = {
  log: string;
  /** Packages whose install scripts were skipped (they may need them). */
  skippedInstallScripts: string[];
};

/**
 * Prepare `node_modules/` for `ctxDir`: copy only package.json and an npm
 * lockfile into a fresh directory, run npm in the fetch sandbox, check the
 * size cap, then move the result into the build context.
 */
export async function fetchNodeDependencies(ctxDir: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const log = opts.log ?? (() => {});
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(join(ctxDir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    throw new FetchError("package.json is not valid JSON", "Fix package.json (it must be a JSON object), then republish.");
  }
  if (pkg["workspaces"] !== undefined) {
    throw new FetchError(
      "package.json declares workspaces (a monorepo), which SCAD does not build yet",
      "Publish the folder of the one site you want to share (the package that has the build script), with its own package.json.",
    );
  }
  const specs = nonRegistrySpecs(pkg);
  if (specs.length > 0) {
    throw new FetchError(
      "package.json has dependencies that do not come from the npm registry",
      `SCAD downloads dependencies only from registry.npmjs.org. Replace these with registry versions (for example "^1.2.3"), then republish: ${specs.slice(0, 5).join("; ")}`,
      { dependencies: specs.slice(0, 20) },
    );
  }

  const work = await mkdtemp(join(tmpdir(), "scad-fetch-"));
  try {
    await copyFile(join(ctxDir, "package.json"), join(work, "package.json"));
    const npmLock = await firstFile(ctxDir, NPM_LOCKFILES);
    if (npmLock) {
      let lock: unknown;
      try {
        lock = JSON.parse(await readFile(join(ctxDir, npmLock), "utf8"));
      } catch {
        throw new FetchError(
          `${npmLock} is not valid JSON`,
          `Delete ${npmLock} (SCAD will resolve one) or regenerate it with \`npm install\`, then republish.`,
        );
      }
      const bad = nonRegistrySources(lock);
      if (bad.length > 0) {
        throw new FetchError(
          `${npmLock} downloads packages from outside the npm registry`,
          `SCAD fetches dependencies only from registry.npmjs.org. Point these at registry versions and regenerate the lockfile with \`npm install\`, then republish: ${bad.slice(0, 5).join("; ")}`,
          { sources: bad.slice(0, 20) },
        );
      }
      await copyFile(join(ctxDir, npmLock), join(work, "package-lock.json"));
    } else {
      const other = await firstFile(ctxDir, OTHER_LOCKFILES);
      log(
        other
          ? `scad-fetch: ${other} found; SCAD installs with npm, resolving versions from package.json (commit a package-lock.json to pin them exactly)`
          : "scad-fetch: no lockfile; resolving versions from package.json",
      );
    }

    const proxyUrl = `http://${proxyOf(opts)}:${EGRESS_PROXY_PORT}`;
    const out = await runInFetchSandbox(
      {
        workDir: work,
        image: FETCH_NODE_IMAGE,
        allow: [NPM_REGISTRY_HOST],
        env: npmFetchEnv(proxyUrl, await safeNpmrcEnv(ctxDir)),
        argv: ["sh", "-ec", NPM_FETCH_SCRIPT],
      },
      opts,
    );
    if (!out.ok) {
      throw new FetchError(
        out.timedOut ? "Downloading dependencies timed out" : "Downloading dependencies from npm failed",
        npmFailureHint(out.log, out.timedOut),
        { phase: "fetch" },
        out.log,
      );
    }
    const modules = join(work, "node_modules");
    if (!(await isDir(modules))) await mkdir(modules);
    const maxBytes = opts.maxBytes ?? FETCH_LIMITS.maxBytes;
    if ((await dirSize(modules, maxBytes)) > maxBytes) {
      throw new FetchError(
        `Dependencies are larger than ${Math.round(maxBytes / 1048576)} MB`,
        "Remove dependencies the site does not use (check package.json for large packages), then republish.",
        { max_bytes: maxBytes },
        out.log,
      );
    }
    const skippedInstallScripts = await packagesWithInstallScripts(modules);
    await rm(join(ctxDir, "node_modules"), { recursive: true, force: true });
    await rename(modules, join(ctxDir, "node_modules"));
    if (!npmLock) {
      // The build sees the lockfile npm resolved, so it agrees with node_modules.
      await copyFile(join(work, "package-lock.json"), join(ctxDir, "package-lock.json")).catch(() => {});
    }
    return { log: out.log, skippedInstallScripts };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Download Jekyll's gems (no install, no extension builds) into `vendor/cache/`. */
export async function fetchRubyGems(ctxDir: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const work = await mkdtemp(join(tmpdir(), "scad-fetch-"));
  try {
    await copyFile(join(ctxDir, "Gemfile"), join(work, "Gemfile"));
    if (await isFile(join(ctxDir, "Gemfile.lock"))) await copyFile(join(ctxDir, "Gemfile.lock"), join(work, "Gemfile.lock"));
    const gemfile = await readFile(join(work, "Gemfile"), "utf8");
    if (/\b(git|github|path)\s*(:|=>)/.test(gemfile)) {
      throw new FetchError(
        "Gemfile uses git or path gems",
        "SCAD downloads gems only from rubygems.org. Use released gem versions in the Gemfile, then republish.",
      );
    }
    const proxyUrl = `http://${proxyOf(opts)}:${EGRESS_PROXY_PORT}`;
    const out = await runInFetchSandbox(
      {
        workDir: work,
        image: FETCH_RUBY_IMAGE,
        allow: [...RUBYGEMS_HOSTS],
        env: {
          HOME: "/tmp",
          GEM_HOME: "/tmp/gems",
          HTTPS_PROXY: proxyUrl,
          HTTP_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          http_proxy: proxyUrl,
        },
        argv: ["sh", "-ec", BUNDLER_FETCH_SCRIPT],
      },
      opts,
    );
    if (!out.ok) {
      throw new FetchError(
        out.timedOut ? "Downloading gems timed out" : "Downloading gems from rubygems.org failed",
        "Check that every gem in the Gemfile exists on rubygems.org and that Gemfile.lock is up to date (run `bundle install` locally), then republish. See details.log_tail.",
        { phase: "fetch" },
        out.log,
      );
    }
    const maxBytes = opts.maxBytes ?? FETCH_LIMITS.maxBytes;
    if ((await dirSize(join(work, "vendor"), maxBytes)) > maxBytes) {
      throw new FetchError(`Gems are larger than ${Math.round(maxBytes / 1048576)} MB`, "Remove gems the site does not use, then republish.");
    }
    await rm(join(ctxDir, "vendor", "cache"), { recursive: true, force: true });
    await mkdir(join(ctxDir, "vendor"), { recursive: true });
    await rename(join(work, "vendor", "cache"), join(ctxDir, "vendor", "cache"));
    await copyFile(join(work, "Gemfile.lock"), join(ctxDir, "Gemfile.lock"));
    return { log: out.log, skippedInstallScripts: [] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function npmFailureHint(log: string, timedOut: boolean): string {
  if (timedOut) {
    return `Dependency downloads get ${Math.round(FETCH_LIMITS.timeoutMs / 60_000)} minutes. Remove large or unused dependencies from package.json, then republish.`;
  }
  if (/package\.json and package-lock\.json[^\n]*in sync/i.test(log) || /Missing: \S+ from lock file/i.test(log)) {
    return "package-lock.json does not match package.json. Run `npm install` in the project to update the lockfile (or delete package-lock.json), then republish.";
  }
  if (/ERESOLVE/.test(log)) {
    return "npm could not resolve the dependency versions (peer dependency conflict). Fix the versions in package.json, or add `legacy-peer-deps=true` to the project's .npmrc, then republish. See details.log_tail.";
  }
  const notFound = /404 Not Found - GET https:\/\/registry\.npmjs\.org\/(\S+)/i.exec(log);
  if (notFound) {
    return `A dependency was not found on the npm registry (${decodeURIComponent(notFound[1] ?? "").replace(/\/-\/.*$/, "")}). Check the package name and version in package.json, then republish.`;
  }
  if (/SCAD egress refused|403 Forbidden|tunneling socket|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(log)) {
    return "A dependency download went somewhere other than registry.npmjs.org, which SCAD refuses. Use only packages from the npm registry, then republish. See details.log_tail.";
  }
  return "npm could not install the dependencies. Read details.log_tail, fix package.json (or the lockfile), then republish.";
}

export type SandboxRun = { ok: boolean; log: string; timedOut: boolean };

/**
 * Run `argv` in the fetch sandbox: a fresh internal network whose only exit
 * is the egress proxy, allowed to reach `allow` (registry hosts) and nothing
 * else. Always cleans up the container, policy file, and network.
 */
export async function runInFetchSandbox(
  job: { workDir: string; image: string; allow: string[]; env: Record<string, string>; argv: string[] },
  opts: FetchOptions = {},
): Promise<SandboxRun> {
  const exec = opts.exec ?? defaultExec;
  const env = buildEnv(opts.parentEnv ?? process.env); // never platform secrets (INV8)
  const id = randomBytes(6).toString("hex");
  const network = `scad-fetch-${id}`;
  const name = `scad-fetch-${id}`;
  const proxy = proxyOf(opts);
  const policyDir = policyDirOf(opts);
  const policyFile = join(policyDir, `fetch-${id}.json`);
  const docker = (args: string[], timeout = 60_000) =>
    exec("docker", args, { env, maxBuffer: 20 * 1024 * 1024, timeout });

  const running = await docker(["inspect", "-f", "{{.State.Running}}", proxy]).catch(() => null);
  if (running?.stdout.trim() !== "true") {
    throw new FetchError(
      "The dependency download step is unavailable (egress proxy not running)",
      "This is a SCAD server problem, not an app problem: the operator must start the egress proxy (`docker compose up -d egress-proxy`). Then republish.",
      { proxy },
    );
  }

  try {
    await docker(["network", "create", "--internal", "--label", "scad.role=fetch", network]);
    const { stdout: subnets } = await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", network]);
    const v4 = subnets.trim().split(/\s+/).find((s) => s.includes("."));
    if (!v4) throw new Error(`fetch network ${network} has no IPv4 subnet`);
    await mkdir(policyDir, { recursive: true });
    await chmod(policyDir, 0o755).catch(() => {});
    const tmp = `${policyFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ appId: `fetch-${id}`, subnet: v4, allow: job.allow })}\n`, { mode: 0o644 });
    await rename(tmp, policyFile);
    await docker(["network", "connect", network, proxy]);
    // The proxy reloads policies about once a second.
    await new Promise((r) => setTimeout(r, 1500));

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const gid = typeof process.getgid === "function" ? process.getgid() : uid;
    const user = uid === undefined ? undefined : `${uid}:${gid}`;
    try {
      const { stdout, stderr } = await docker(
        fetchRunArgs({ name, network, workDir: job.workDir, image: job.image, env: job.env, argv: job.argv, user }),
        opts.timeoutMs ?? FETCH_LIMITS.timeoutMs,
      );
      return { ok: true, log: `${stdout}\n${stderr}`, timedOut: false };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      return {
        ok: false,
        log: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? String(err)}`,
        timedOut: e.killed === true,
      };
    }
  } finally {
    await docker(["rm", "-f", name]).catch(() => {});
    await rm(policyFile, { force: true }).catch(() => {});
    await docker(["network", "disconnect", "-f", network, proxy]).catch(() => {});
    await docker(["network", "rm", network]).catch(() => {});
  }
}

/** Total bytes under `dir` (stops counting once over `stopAt`). Symlinks count as links. */
export async function dirSize(dir: string, stopAt = Number.POSITIVE_INFINITY): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= stopAt) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else total += (await lstat(p)).size;
    }
  }
  return total;
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

/** Installed packages that declare install scripts or a native addon (binding.gyp). */
export async function packagesWithInstallScripts(modules: string): Promise<string[]> {
  const found = new Set<string>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        await visit(join(dir, e.name), depth);
        continue;
      }
      const pkgDir = join(dir, e.name);
      try {
        const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as {
          name?: string;
          scripts?: Record<string, unknown>;
          gypfile?: boolean;
        };
        const scripts = pkg.scripts ?? {};
        const hasScript = INSTALL_SCRIPTS.some((s) => typeof scripts[s] === "string");
        if (hasScript || pkg.gypfile === true || (await isFile(join(pkgDir, "binding.gyp")))) {
          found.add(pkg.name ?? e.name);
        }
      } catch {
        // not a package
      }
      if (depth < 2) await visit(join(pkgDir, "node_modules"), depth + 1);
    }
  };
  await visit(modules, 0);
  return [...found].sort();
}
