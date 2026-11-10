import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, normalize, posix } from "node:path";
import { makeError, type ErrorEnvelope } from "@scad/shared";

/**
 * T2.4 auto-detect: when an upload has no Dockerfile, SCAD writes one from a
 * built-in template (Node, Python, static). Templates never fetch anything:
 * builds run with `--network=none` (INV8), so dependencies must be bundled or
 * vendored. Detection reads only regular files (never follows symlinks) and
 * writes only `Dockerfile` in the build context.
 */
export type BuildKind = "dockerfile" | "node" | "python" | "static";

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
  "Add a Dockerfile, or use one of the built-in layouts: a package.json (Node: scripts.start, main, server.js, or index.js), a requirements.txt with app.py / main.py / server.py (Python), or an index.html (static site).";

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
      "package.json has dependencies, but builds run offline and cannot npm install",
      "Bundle the app into one file with its dependencies (for example `esbuild server.js --bundle --platform=node --outfile=dist/server.js`) and publish that without the dependencies list, or add a Dockerfile that copies vendored dependencies. See docs/build-isolation.md.",
      { dependencies: Object.keys(deps as object).slice(0, 20) },
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
      "requirements.txt lists packages, but builds run offline and cannot pip install from PyPI",
      "Vendor the packages as wheels: run `pip download -r requirements.txt -d wheels --only-binary=:all: --platform musllinux_1_2_x86_64 --python-version 3.12` (use aarch64 on Apple silicon) and publish the wheels/ folder with the app. See docs/build-isolation.md.",
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

/**
 * Make `dir` buildable: keep the app's own Dockerfile, or write one from the
 * first matching template. Throws {@link AutodetectError} (BUILD_FAILED with a
 * hint) when nothing fits or the layout cannot build offline.
 */
export async function prepareBuildContext(dir: string, port: number): Promise<{ kind: BuildKind }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`);
  const present = await kindOf(dir, "Dockerfile");
  if (present === "file") return { kind: "dockerfile" };
  if (present !== null) {
    throw new AutodetectError("Dockerfile is not a regular file", "Replace the Dockerfile symlink or folder with a real file.");
  }

  let kind: Exclude<BuildKind, "dockerfile">;
  let dockerfile: string;
  if ((await kindOf(dir, "package.json")) === "file") {
    kind = "node";
    dockerfile = await nodeTemplate(dir, port);
  } else if ((await kindOf(dir, "requirements.txt")) === "file") {
    kind = "python";
    dockerfile = await pythonTemplate(dir, port);
  } else if ((await kindOf(dir, "index.html")) === "file") {
    kind = "static";
    dockerfile = staticTemplate(port);
  } else {
    throw new AutodetectError("No Dockerfile and no recognised app layout", SUPPORTED);
  }
  await writeFile(join(dir, "Dockerfile"), dockerfile, { flag: "wx" });
  return { kind };
}
