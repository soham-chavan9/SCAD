import { copyFile, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { makeError, type ErrorEnvelope } from "@scad/shared";
import { CONFIG_FILES, detectFramework, scriptOf, type Configs, type ServerSite, type StaticSite } from "./frameworks.js";
import { prepareServerSite, serverStages, ServerSiteError } from "./server-sites.js";

/**
 * T2.4 auto-detect: when an upload has no Dockerfile, SCAD writes one from a
 * built-in template. Templates never fetch anything: builds run with
 * `--network=none` (INV8). T3.2 site frameworks (Vite, Astro, Docusaurus,
 * Hugo, Jekyll, ...) get their dependencies from the trusted fetch step
 * (`fetch-deps.ts`) that runs before the build; the plan says which.
 * Detection reads only regular files (never follows symlinks) and writes
 * only `Dockerfile`, `.dockerignore`, and `.scad/` in the build context (a
 * temporary copy of the upload, never the founder's own files).
 */
export type BuildKind = "dockerfile" | "node" | "python" | "static" | "site" | "server-site" | "hugo" | "jekyll";

export type BuildPlan = {
  kind: BuildKind;
  /** Framework id for site builds, e.g. `vite-react`, `docusaurus`, `hugo`. */
  framework?: string;
  /** Human name of the framework, for logs. */
  label?: string;
  /** Dependencies the trusted fetch step must download before the build. */
  fetch?: "npm" | "bundler";
  /** T3.3: pinned packages SCAD adds for the build (a framework's Node adapter). */
  extraDependencies?: Record<string, string>;
  /** What SCAD changed in the build copy, for the build log. */
  note?: string;
};

export type PrepareOptions = {
  /** Path to a verified Hugo binary (downloaded by the builder on first use). */
  hugoBinary?: () => Promise<string>;
};

export class AutodetectError extends Error {
  readonly envelope: ErrorEnvelope;
  constructor(message: string, hint: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AutodetectError";
    this.envelope = makeError("BUILD_FAILED", message, hint, details);
  }
}

export const NODE_BASE_IMAGE = "node:22-alpine";
export const PYTHON_BASE_IMAGE = "python:3.12-alpine";
export const STATIC_BASE_IMAGE = "busybox:1.36";
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Relative path inside the app, plain characters only, no `..`. */
const SAFE_REL_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/;

const SUPPORTED =
  "Add a Dockerfile, or use one of the built-in layouts: a site project with package.json (Vite, React, Vue, Svelte, Angular, Astro, Next.js, Docusaurus, Gatsby, VitePress, Eleventy, or any `build` script), a Hugo site (hugo.toml), a Jekyll site (_config.yml + Gemfile), a package.json Node app (scripts.start, main, server.js, or index.js), a requirements.txt with app.py / main.py / server.py (Python), or an index.html (static site).";

const SITE_IMAGE = NODE_BASE_IMAGE;
export const JEKYLL_BUILD_IMAGE = "ruby:3.3";
/** SCAD's files in the build context (the CLI never uploads `.scad/`). */
const SCAD_DIR = ".scad";
const STATIC_SERVER_SOURCE = fileURLToPath(new URL("../assets/static-server.mjs", import.meta.url));

/** Build-time env: production mode, no telemetry or prompts, caches in /tmp. */
const SITE_BUILD_ENV = [
  "NODE_ENV=production",
  "CI=1",
  "HOME=/tmp",
  "NPM_CONFIG_CACHE=/tmp/.npm",
  "NPM_CONFIG_UPDATE_NOTIFIER=false",
  "NEXT_TELEMETRY_DISABLED=1",
  "ASTRO_TELEMETRY_DISABLED=1",
  "GATSBY_TELEMETRY_DISABLED=1",
  "NUXT_TELEMETRY_DISABLED=1",
  "NG_CLI_ANALYTICS=false",
  "DO_NOT_TRACK=1",
].join(" ");

async function kindOf(dir: string, name: string): Promise<"file" | "dir" | null> {
  try {
    const st = await lstat(join(dir, name));
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    return null; // symlinks and anything else are ignored
  } catch {
    return null;
  }
}

async function readSmallText(dir: string, name: string): Promise<string> {
  const st = await lstat(join(dir, name));
  if (st.size > MAX_MANIFEST_BYTES) {
    throw new AutodetectError(`${name} is larger than 1 MB`, `Keep ${name} small; it describes the app, it is not data.`);
  }
  return readFile(join(dir, name), "utf8");
}

const cmd = (argv: string[]) => `CMD ${JSON.stringify(argv)}`;

async function nodeTemplate(dir: string, port: number): Promise<string> {
  let pkg: { scripts?: { start?: unknown }; main?: unknown; dependencies?: unknown };
  try {
    pkg = JSON.parse(await readSmallText(dir, "package.json")) as typeof pkg;
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) throw new Error("not an object");
  } catch (err) {
    if (err instanceof AutodetectError) throw err;
    throw new AutodetectError("package.json is not valid JSON", "Fix package.json (it must be a JSON object), then republish.");
  }

  const deps = pkg.dependencies;
  const hasDeps = typeof deps === "object" && deps !== null && Object.keys(deps).length > 0;
  if (hasDeps && (await kindOf(dir, "node_modules")) !== "dir") {
    throw new AutodetectError(
      "This looks like a backend app (a Node server with npm dependencies and no website framework); backend apps come in SCAD M4",
      "SCAD M3 publishes websites: plain HTML, static builds (Vite, React, Astro, ...), and server-rendered sites (Next.js, Nuxt, SvelteKit, Remix, Astro). Publish the site part on its own, or bundle the server into one file with its dependencies (for example `esbuild server.js --bundle --platform=node --outfile=dist/server.js`) and publish that without the dependencies list. See docs/autodetect.md.",
      { dependencies: Object.keys(deps as object).slice(0, 20), backend: true },
    );
  }

  let start: string[];
  if (typeof pkg.scripts?.start === "string" && pkg.scripts.start.trim() !== "") {
    start = ["npm", "start"];
  } else if (typeof pkg.main === "string" && SAFE_REL_PATH.test(posix.normalize(pkg.main))) {
    const main = posix.normalize(pkg.main);
    if ((await kindOf(dir, normalize(main))) !== "file") {
      throw new AutodetectError(`package.json "main" points to ${main}, which is not in the upload`, `Publish ${main}, or fix "main" in package.json.`);
    }
    start = ["node", main];
  } else if (typeof pkg.main === "string") {
    throw new AutodetectError(`package.json "main" is not a plain relative path`, 'Set "main" to a file inside the app, such as "server.js".');
  } else if ((await kindOf(dir, "server.js")) === "file") {
    start = ["node", "server.js"];
  } else if ((await kindOf(dir, "index.js")) === "file") {
    start = ["node", "index.js"];
  } else {
    throw new AutodetectError(
      "Could not tell how to start this Node app",
      'Add "scripts": {"start": "node server.js"} to package.json, set "main", or add server.js / index.js.',
    );
  }

  return [
    `FROM ${NODE_BASE_IMAGE}`,
    "WORKDIR /home/node/app",
    "COPY --chown=node:node . .",
    // npm writes its cache and logs under HOME; the root filesystem is read-only at runtime.
    `ENV NODE_ENV=production PORT=${port} NPM_CONFIG_CACHE=/tmp/.npm NPM_CONFIG_UPDATE_NOTIFIER=false`,
    "USER node",
    `EXPOSE ${port}`,
    cmd(start),
    "",
  ].join("\n");
}

async function pythonTemplate(dir: string, port: number): Promise<string> {
  const requirements = (await readSmallText(dir, "requirements.txt"))
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
  const hasWheels = (await kindOf(dir, "wheels")) === "dir";
  if (requirements.length > 0 && !hasWheels) {
    throw new AutodetectError(
      "requirements.txt lists packages, but builds run offline and cannot pip install from PyPI (Python backend apps come in SCAD M4)",
      "Backend apps with packages come in SCAD M4. For now, vendor the packages as wheels: run `pip download -r requirements.txt -d wheels --only-binary=:all: --platform musllinux_1_2_x86_64 --python-version 3.12` (use aarch64 on Apple silicon) and publish the wheels/ folder with the app. See docs/build-isolation.md.",
      { requirements: requirements.slice(0, 20) },
    );
  }
  const entry = (
    await Promise.all(["app.py", "main.py", "server.py"].map(async (f) => ((await kindOf(dir, f)) === "file" ? f : null)))
  ).find((f): f is string => f !== null);
  if (!entry) {
    throw new AutodetectError("Could not find the Python app's entry file", "Name the entry file app.py, main.py, or server.py, or add a Dockerfile.");
  }

  return [
    `FROM ${PYTHON_BASE_IMAGE}`,
    "WORKDIR /app",
    "COPY . .",
    ...(requirements.length > 0
      ? ["RUN pip install --no-index --find-links /app/wheels --no-cache-dir --target /app/.deps -r requirements.txt"]
      : []),
    `ENV PYTHONPATH=/app/.deps PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=${port}`,
    "USER 65534:65534",
    `EXPOSE ${port}`,
    cmd(["python", entry]),
    "",
  ].join("\n");
}

function staticTemplate(port: number): string {
  return [
    `FROM ${STATIC_BASE_IMAGE}`,
    "COPY . /site",
    // Platform files are not part of the site.
    "RUN rm -f /site/scad.json /site/Dockerfile /site/.dockerignore",
    "USER 65534:65534",
    `EXPOSE ${port}`,
    cmd(["httpd", "-f", "-v", "-p", String(port), "-h", "/site"]),
    "",
  ].join("\n");
}

/** Shell that moves the first output folder with an index.html (else the first that exists) to `.scad/site`. */
export function pickOutputScript(candidates: string[]): string {
  const list = candidates.join(" ");
  return [
    `for d in ${list}; do if [ -f "$d/index.html" ]; then mv "$d" ${SCAD_DIR}/site; exit 0; fi; done`,
    `for d in ${list}; do if [ -d "$d" ]; then mv "$d" ${SCAD_DIR}/site; exit 0; fi; done`,
    `echo "scad: the build finished but no output folder was found (looked for: ${list})" >&2`,
    "exit 1",
  ].join("; ");
}

/** Final stage shared by every static site build: the output behind SCAD's static server. */
function staticServeStage(port: number): string[] {
  return [
    `FROM ${SITE_IMAGE}`,
    `COPY --from=build /home/node/app/${SCAD_DIR}/site /site`,
    `COPY ${SCAD_DIR}/static-server.mjs /srv/scad-static-server.mjs`,
    `ENV NODE_ENV=production PORT=${port}`,
    "USER node",
    `EXPOSE ${port}`,
    cmd(["node", "/srv/scad-static-server.mjs", "/site"]),
    "",
  ];
}

const BUILD_STAGE_PREAMBLE = [
  `FROM ${SITE_IMAGE} AS build`,
  "RUN install -d -o node -g node /home/node/app",
  "WORKDIR /home/node/app",
  "COPY --chown=node:node . .",
  "USER node",
  `ENV ${SITE_BUILD_ENV}`,
];

function siteTemplate(site: StaticSite, hasBuildScript: boolean, port: number): string {
  const build = hasBuildScript ? "RUN npm run build" : `RUN ${JSON.stringify([`node_modules/.bin/${site.defaultBuild[0]}`, ...site.defaultBuild.slice(1)])}`;
  return [
    `# SCAD built-in template: ${site.label} static site (T3.2)`,
    ...BUILD_STAGE_PREAMBLE,
    build,
    `RUN ${pickOutputScript(site.output)}`,
    "",
    ...staticServeStage(port),
  ].join("\n");
}

function serverTemplate(site: ServerSite, pkg: Record<string, unknown>, configs: Configs, port: number): string {
  const hasBuild = scriptOf(pkg, "build") !== undefined;
  const defaults: Record<ServerSite["id"], string[]> = {
    next: ["next", "build"],
    nuxt: ["nuxt", "build"],
    sveltekit: ["vite", "build"],
    remix: ["react-router", "build"],
    astro: ["astro", "build"],
  };
  const d = defaults[site.id];
  const build = hasBuild ? "RUN npm run build" : `RUN ${JSON.stringify([`node_modules/.bin/${d[0]}`, ...d.slice(1)])}`;
  const { afterBuild, runtime } = serverStages(site, pkg, configs, port, SITE_IMAGE);
  return [
    `# SCAD built-in template: ${site.label} server-rendered site (T3.3)`,
    ...BUILD_STAGE_PREAMBLE,
    build,
    ...afterBuild,
    "",
    ...runtime,
    "",
  ].join("\n");
}

function hugoTemplate(port: number): string {
  return [
    "# SCAD built-in template: Hugo site (T3.2)",
    ...BUILD_STAGE_PREAMBLE,
    `RUN ./${SCAD_DIR}/hugo --minify --baseURL / --destination ${SCAD_DIR}/site`,
    "",
    ...staticServeStage(port),
  ].join("\n");
}

function jekyllTemplate(port: number): string {
  return [
    "# SCAD built-in template: Jekyll site (T3.2)",
    `FROM ${JEKYLL_BUILD_IMAGE} AS build`,
    "WORKDIR /home/node/app",
    "COPY . .",
    "ENV JEKYLL_ENV=production BUNDLE_PATH=/home/node/app/.scad/bundle BUNDLE_DISABLE_VERSION_CHECK=1 BUNDLE_SILENCE_ROOT_WARNING=1",
    // Gems come from vendor/cache (the fetch step); native extensions compile here, offline.
    "RUN bundle install --local",
    `RUN bundle exec jekyll build --destination ${SCAD_DIR}/site`,
    "",
    ...staticServeStage(port),
  ].join("\n");
}

async function readConfigs(dir: string): Promise<Configs> {
  const configs: Configs = {};
  for (const name of CONFIG_FILES) {
    if ((await kindOf(dir, name)) === "file") configs[name] = await readSmallText(dir, name);
  }
  return configs;
}

async function readPackageJson(dir: string): Promise<Record<string, unknown>> {
  try {
    const pkg = JSON.parse(await readSmallText(dir, "package.json")) as unknown;
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) throw new Error("not an object");
    return pkg as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AutodetectError) throw err;
    throw new AutodetectError("package.json is not valid JSON", "Fix package.json (it must be a JSON object), then republish.");
  }
}

async function anyFile(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) if ((await kindOf(dir, n)) === "file") return true;
  return false;
}

/** SCAD's own files go in `.scad/` (an upload's own `.scad/` is dropped) and a .dockerignore that keeps node_modules. */
async function prepareScadDir(dir: string): Promise<void> {
  await rm(join(dir, SCAD_DIR), { recursive: true, force: true });
  await mkdir(join(dir, SCAD_DIR));
  await copyFile(STATIC_SERVER_SOURCE, join(dir, SCAD_DIR, "static-server.mjs"));
  await rm(join(dir, ".dockerignore"), { force: true });
  await writeFile(join(dir, ".dockerignore"), ".git\n");
}

/**
 * Make `dir` buildable: keep the app's own Dockerfile, or write one from the
 * first matching template. Throws {@link AutodetectError} (BUILD_FAILED with a
 * hint) when nothing fits or the layout cannot build. The returned plan says
 * whether the trusted fetch step must run first.
 */
export async function prepareBuildContext(dir: string, port: number, opts: PrepareOptions = {}): Promise<BuildPlan> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
  const present = await kindOf(dir, "Dockerfile");
  if (present === "file") return { kind: "dockerfile" };
  if (present !== null) {
    throw new AutodetectError("Dockerfile is not a regular file", "Replace the Dockerfile symlink or folder with a real file.");
  }

  let plan: BuildPlan;
  let dockerfile: string;
  const hasPackageJson = (await kindOf(dir, "package.json")) === "file";
  const isHugo =
    (await anyFile(dir, ["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json"])) ||
    (!hasPackageJson &&
      (await anyFile(dir, ["config.toml", "config.yaml"])) &&
      ((await kindOf(dir, "content")) === "dir" || (await kindOf(dir, "layouts")) === "dir"));
  const isJekyll =
    !isHugo && (await kindOf(dir, "Gemfile")) === "file" && (await anyFile(dir, ["_config.yml", "_config.yaml"]));

  if (isHugo) {
    await prepareScadDir(dir);
    if (!opts.hugoBinary) throw new Error("Hugo binary provider not configured");
    const bin = await opts.hugoBinary();
    await copyFile(bin, join(dir, SCAD_DIR, "hugo"));
    await chmod(join(dir, SCAD_DIR, "hugo"), 0o755);
    plan = { kind: "hugo", framework: "hugo", label: "Hugo" };
    dockerfile = hugoTemplate(port);
  } else if (isJekyll) {
    await prepareScadDir(dir);
    plan = { kind: "jekyll", framework: "jekyll", label: "Jekyll", fetch: "bundler" };
    dockerfile = jekyllTemplate(port);
  } else if (hasPackageJson) {
    const pkg = await readPackageJson(dir);
    const site = detectFramework(pkg, await readConfigs(dir));
    if (site?.mode === "static") {
      const hasBuild = scriptOf(pkg, "build") !== undefined;
      if (!hasBuild && site.defaultBuild.length === 0) {
        throw new AutodetectError("package.json has no build script", 'Add "scripts": {"build": "..."} to package.json, then republish.');
      }
      await prepareScadDir(dir);
      plan = { kind: "site", framework: site.id, label: site.label, fetch: "npm" };
      dockerfile = siteTemplate(site, hasBuild, port);
    } else if (site?.mode === "server") {
      const configs = await readConfigs(dir);
      await prepareScadDir(dir);
      let server;
      try {
        server = await prepareServerSite(dir, site, pkg, configs);
        dockerfile = serverTemplate(site, pkg, configs, port);
      } catch (err) {
        if (err instanceof ServerSiteError) throw new AutodetectError(err.message, err.hint, { framework: site.id });
        throw err;
      }
      plan = {
        kind: "server-site",
        framework: site.id,
        label: site.label,
        fetch: "npm",
        ...(Object.keys(server.extraDependencies).length > 0 ? { extraDependencies: server.extraDependencies } : {}),
        ...(server.note ? { note: server.note } : {}),
      };
    } else {
      plan = { kind: "node" };
      dockerfile = await nodeTemplate(dir, port);
    }
  } else if ((await kindOf(dir, "requirements.txt")) === "file") {
    plan = { kind: "python" };
    dockerfile = await pythonTemplate(dir, port);
  } else if ((await kindOf(dir, "index.html")) === "file") {
    plan = { kind: "static" };
    dockerfile = staticTemplate(port);
  } else {
    throw new AutodetectError("No Dockerfile and no recognised app layout", SUPPORTED);
  }
  await writeFile(join(dir, "Dockerfile"), dockerfile, { flag: "wx" });
  return plan;
}
