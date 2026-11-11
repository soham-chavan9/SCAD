import type { ServerSite } from "./frameworks.js";

/**
 * T3.3 server-rendered sites (Next.js, Nuxt, SvelteKit, Remix / React Router,
 * Astro with a server). They build offline like static sites, then run on
 * `node:22-alpine` as `node` with production `node_modules`, listening on
 * `PORT` under the same hardened profile and egress rules as every app.
 *
 * SvelteKit's default `adapter-auto` gets `adapter-node` (pinned below, fetched
 * from the npm registry by the trusted fetch step); the founder's files are
 * never changed. Other missing adapters get a hint that says what to change.
 */
export const NODE_ADAPTERS = {
  sveltekit: { name: "@sveltejs/adapter-node", version: "6.0.2" },
  astro: { name: "@astrojs/node" },
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

export class ServerSiteError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ServerSiteError";
  }
}

const OTHER_SVELTEKIT_ADAPTERS = ["@sveltejs/adapter-vercel", "@sveltejs/adapter-netlify", "@sveltejs/adapter-cloudflare", "@sveltejs/adapter-cloudflare-workers"];

/**
 * Decide how `site` runs on Node, and which extra dependencies the fetch
 * step must add. Never edits files: a SvelteKit `adapter-auto` is pointed at
 * `adapter-node` inside the fetched node_modules during the build (that is
 * what adapter-auto itself does on a supported host).
 */
export function planServerSite(site: ServerSite, pkg: Pkg, configs: Record<string, string>): ServerPlan {
  const d = deps(pkg);
  if (site.id === "sveltekit" && !d.has(NODE_ADAPTERS.sveltekit.name)) {
    const { name, version } = NODE_ADAPTERS.sveltekit;
    if (d.has("@sveltejs/adapter-auto")) {
      return {
        extraDependencies: { [name]: version },
        note: `SvelteKit: adapter-auto builds with ${name}@${version} on SCAD (added in the build; your files are unchanged)`,
      };
    }
    const other = OTHER_SVELTEKIT_ADAPTERS.find((a) => d.has(a));
    throw new ServerSiteError(
      `This SvelteKit site uses ${other ?? "no adapter SCAD can run"}`,
      `SCAD runs SvelteKit with ${name}. Install it (\`npm i -D ${name}\`), use it as the adapter instead of ${other ?? "the current one"}, then republish. (Or use @sveltejs/adapter-static for a site with no server code.)`,
    );
  }
  if (site.id === "astro") {
    if (!d.has(NODE_ADAPTERS.astro.name)) {
      throw new ServerSiteError(
        "This Astro site renders on a server but does not use the Node adapter",
        `Install @astrojs/node (\`npx astro add node\`), set \`adapter: node({ mode: "standalone" })\` in astro.config, then republish. Without server pages, remove \`output: "server"\` and the adapter to publish it as a static site.`,
      );
    }
    if (Object.values(configs).some((t) => /mode\s*:\s*["'`]middleware["'`]/.test(t))) {
      throw new ServerSiteError(
        "The Astro Node adapter is in middleware mode, which needs your own server",
        'Set `adapter: node({ mode: "standalone" })` in astro.config, then republish.',
      );
    }
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
export function serverStages(
  site: ServerSite,
  pkg: Pkg,
  configs: Record<string, string>,
  port: number,
  image: string,
): { beforeBuild: string[]; afterBuild: string[]; runtime: string[] } {
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
          beforeBuild: [],
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
        beforeBuild: [],
        afterBuild: [prune, "RUN rm -rf .next/cache && ln -s /tmp/next-cache .next/cache"],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(["node_modules/.bin/next", "start"])}`],
      };
    }
    case "nuxt":
      return {
        beforeBuild: [],
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
        beforeBuild: deps(pkg).has(NODE_ADAPTERS.sveltekit.name)
          ? []
          : [`RUN printf '%s\\n' 'export { default } from "${NODE_ADAPTERS.sveltekit.name}";' > node_modules/@sveltejs/adapter-auto/index.js`],
        afterBuild: [prune],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(["node", "build"])}`],
      };
    case "astro":
      return {
        beforeBuild: [],
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
        beforeBuild: [],
        afterBuild: [prune],
        runtime: [...runtimeHead, copyApp, ...runtimeTail, `CMD ${json(start)}`],
      };
    }
  }
}
