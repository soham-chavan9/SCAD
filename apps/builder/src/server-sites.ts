import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerSite } from "./frameworks.js";

/**
 * T3.3 server-rendered sites (Next.js, Nuxt, SvelteKit, Remix / React Router,
 * Astro with a server). They build offline like static sites, then run on
 * `node:22-alpine` as `node` with production `node_modules`, listening on
 * `PORT` under the same hardened profile and egress rules as every app.
 *
 * When a project lacks the Node adapter, SCAD adds it in the build context
 * (a temporary copy of the upload): the founder's files are never changed.
 * The adapter versions below are pinned and fetched from the npm registry by
 * the trusted fetch step like any other dependency.
 */
export const NODE_ADAPTERS = {
  sveltekit: { name: "@sveltejs/adapter-node", version: "6.0.2" },
  astro: { name: "@astrojs/node", version: "11.1.12" },
} as const;

export type ServerPlan = {
  /** Extra dependencies (pinned, SCAD-chosen) the fetch step adds. */
  extraDependencies: Record<string, string>;
  /** Log line describing what SCAD changed in the build copy, if anything. */
  note?: string;
};

type Pkg = { dependencies?: unknown; devDependencies?: unknown; scripts?: unknown };

function deps(pkg: Pkg): Set<string> {
  const all = new Set<string>();
  for (const f of [pkg.dependencies, pkg.devDependencies]) {
    if (typeof f === "object" && f !== null) for (const k of Object.keys(f)) all.add(k);
  }
  return all;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function firstExisting(dir: string, names: string[]): Promise<string | undefined> {
  for (const n of names) if (await isFile(join(dir, n))) return n;
  return undefined;
}

export class ServerSiteError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ServerSiteError";
  }
}

/**
 * Move the founder's config aside (in the build copy) and write one that
 * imports it and swaps in the Node adapter. ESM configs only; a CommonJS
 * config gets a hint instead.
 */
async function wrapConfig(
  dir: string,
  candidates: string[],
  build: (founderPath: string) => string,
  what: string,
): Promise<void> {
  const name = await firstExisting(dir, candidates);
  if (!name) {
    const target = candidates[0]!;
    await writeFile(join(dir, target), build(""));
    return;
  }
  const text = await readFile(join(dir, name), "utf8");
  if (/\bmodule\.exports\b|\brequire\s*\(/.test(text) && !/\bexport\s+default\b/.test(text)) {
    throw new ServerSiteError(
      `${name} is CommonJS, so SCAD cannot add the Node adapter for you`,
      `Install ${what} and set it as the adapter in ${name}, then republish.`,
    );
  }
  const ext = name.slice(name.lastIndexOf("."));
  const founder = `${name.slice(0, name.lastIndexOf("."))}.founder${ext}`;
  await rename(join(dir, name), join(dir, founder));
  await writeFile(join(dir, name), build(`./${founder}`));
}

/**
 * Prepare the build copy for `site` and say which extra dependencies the
 * fetch step must add.
 */
export async function prepareServerSite(dir: string, site: ServerSite, pkg: Pkg, configs: Record<string, string>): Promise<ServerPlan> {
  const d = deps(pkg);
  if (site.id === "sveltekit" && !d.has(NODE_ADAPTERS.sveltekit.name)) {
    const { name, version } = NODE_ADAPTERS.sveltekit;
    await wrapConfig(
      dir,
      ["svelte.config.js", "svelte.config.mjs"],
      (founder) =>
        [
          "// Written by SCAD in the build copy: the founder's config with the Node adapter.",
          `import adapter from "${name}";`,
          founder ? `import founder from "${founder}";` : "const founder = {};",
          "export default { ...founder, kit: { ...(founder.kit ?? {}), adapter: adapter() } };",
          "",
        ].join("\n"),
      name,
    );
    return { extraDependencies: { [name]: version }, note: `SvelteKit: building with ${name}@${version} (added by SCAD; your files are unchanged)` };
  }
  if (site.id === "astro" && !d.has(NODE_ADAPTERS.astro.name)) {
    const { name, version } = NODE_ADAPTERS.astro;
    await wrapConfig(
      dir,
      ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts"],
      (founder) =>
        [
          "// Written by SCAD in the build copy: the founder's config with the Node adapter.",
          `import node from "${name}";`,
          founder ? `import founder from "${founder}";` : "const founder = {};",
          'export default { ...founder, output: "server", adapter: node({ mode: "standalone" }) };',
          "",
        ].join("\n"),
      name,
    );
    return { extraDependencies: { [name]: version }, note: `Astro: building with ${name}@${version} in standalone mode (added by SCAD; your files are unchanged)` };
  }
  if (site.id === "astro" && Object.values(configs).some((t) => /mode\s*:\s*["'`]middleware["'`]/.test(t))) {
    throw new ServerSiteError(
      "The Astro Node adapter is in middleware mode, which needs your own server",
      'Set `adapter: node({ mode: "standalone" })` in astro.config, then republish.',
    );
  }
  return { extraDependencies: {} };
}

/** Process env every server site gets: bind all interfaces, production mode, caches in /tmp. */
export const SERVER_RUNTIME_ENV = [
  "NODE_ENV=production",
  "HOST=0.0.0.0",
  "HOSTNAME=0.0.0.0",
  "NITRO_HOST=0.0.0.0",
  "NEXT_TELEMETRY_DISABLED=1",
  "NPM_CONFIG_CACHE=/tmp/.npm",
  "NPM_CONFIG_UPDATE_NOTIFIER=false",
].join(" ");

const json = (argv: string[]) => JSON.stringify(argv);

/**
 * Build-stage commands after the site's build, and the runtime stage. The
 * build stage is the shared `node:22-alpine` preamble (offline, as `node`).
 */
export function serverStages(site: ServerSite, pkg: Pkg, configs: Record<string, string>, port: number, image: string): { afterBuild: string[]; runtime: string[] } {
  const scripts = (typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {}) as Record<string, unknown>;
  const hasStart = typeof scripts["start"] === "string" && String(scripts["start"]).trim() !== "";
  const runtimeHead = [`FROM ${image}`, "WORKDIR /home/node/app"];
  const runtimeTail = [`ENV ${SERVER_RUNTIME_ENV} PORT=${port}`, "USER node", `EXPOSE ${port}`];
  // Keep production dependencies only (offline: npm prune never downloads).
  const prune = "RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund";
  const copyApp = "COPY --from=build --chown=node:node /home/node/app /home/node/app";

  switch (site.id) {
    case "next": {
      const standalone = Object.entries(configs).some(([n, t]) => n.startsWith("next.config") && /output\s*:\s*["'`]standalone["'`]/.test(t));
      if (standalone) {
        return {
          afterBuild: [
            "RUN cp -r .next/static .next/standalone/.next/static && if [ -d public ]; then cp -r public .next/standalone/public; fi",
          ],
          runtime: [
            ...runtimeHead,
            "COPY --from=build --chown=node:node /home/node/app/.next/standalone /home/node/app",
            // Next writes its cache under .next/cache; the root filesystem is read-only.
            "RUN rm -rf .next/cache && ln -s /tmp/next-cache .next/cache",
            ...runtimeTail,
            `CMD ${json(["node", "server.js"])}`,
          ],
        };
      }
      return {
        afterBuild: [prune, "RUN rm -rf .next/cache && ln -s /tmp/next-cache .next/cache"],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(["node_modules/.bin/next", "start"])}`],
      };
    }
    case "nuxt":
      return {
        afterBuild: [],
        // Nitro's node-server output is self-contained (its own node_modules).
        runtime: [
          ...runtimeHead,
          "COPY --from=build --chown=node:node /home/node/app/.output /home/node/app/.output",
          ...runtimeTail,
          `CMD ${json(["node", ".output/server/index.mjs"])}`,
        ],
      };
    case "sveltekit":
      return {
        afterBuild: [prune],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(["node", "build"])}`],
      };
    case "astro":
      return {
        afterBuild: [prune],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(["node", "dist/server/entry.mjs"])}`],
      };
    case "remix": {
      const d = deps(pkg);
      const serve = d.has("@react-router/serve")
        ? ["node_modules/.bin/react-router-serve", "build/server/index.js"]
        : d.has("@remix-run/serve")
          ? ["node_modules/.bin/remix-serve", "build/server/index.js"]
          : null;
      const start = hasStart ? ["npm", "start"] : serve;
      if (!start) {
        throw new ServerSiteError(
          "Could not tell how to start this Remix / React Router site",
          'Add "@react-router/serve" to dependencies and "start": "react-router-serve ./build/server/index.js" to package.json scripts, then republish.',
        );
      }
      return {
        afterBuild: [prune],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(start)}`],
      };
    }
  }
}
