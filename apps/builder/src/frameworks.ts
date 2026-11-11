/**
 * T3.2 site framework detection. Reads package.json (and, for a few
 * frameworks, the config file as text: never executed) and decides how the
 * site builds and where its output lands.
 */

export type StaticSite = {
  mode: "static";
  /** Stable id used in logs and tests, e.g. `vite-react`. */
  id: string;
  /** Human name for logs and hints. */
  label: string;
  /** Output folders to try, in order (shell globs allowed, SCAD constants only). */
  output: string[];
  /** argv when package.json has no `build` script. */
  defaultBuild: string[];
};

export type ServerSite = {
  mode: "server";
  id: "next" | "nuxt" | "sveltekit" | "remix" | "astro";
  label: string;
};

export type SiteFramework = StaticSite | ServerSite;

/** Generic fallback order from TASKS.md T3.2. */
export const GENERIC_OUTPUT = ["dist", "build", "out", "public", "_site"];

type Pkg = {
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
};

function names(pkg: Pkg): Set<string> {
  const all = new Set<string>();
  for (const field of [pkg.dependencies, pkg.devDependencies]) {
    if (typeof field === "object" && field !== null) for (const k of Object.keys(field)) all.add(k);
  }
  return all;
}

export function scriptOf(pkg: Pkg, name: string): string | undefined {
  const scripts = pkg.scripts;
  if (typeof scripts !== "object" || scripts === null) return undefined;
  const v = (scripts as Record<string, unknown>)[name];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** Config file contents by name (only the ones that exist). */
export type Configs = Record<string, string>;

const has = (configs: Configs, prefix: string, re: RegExp) =>
  Object.entries(configs).some(([name, text]) => name.startsWith(prefix) && re.test(text));

export const CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "astro.config.mjs",
  "astro.config.js",
  "astro.config.ts",
  "astro.config.mts",
  "react-router.config.ts",
  "react-router.config.js",
];

const ASTRO_SERVER_ADAPTERS = ["@astrojs/node", "@astrojs/vercel", "@astrojs/netlify", "@astrojs/cloudflare"];

/**
 * The site framework of a package.json project, or `null` when it is not a
 * recognised site (a plain Node app, or a build script with no framework).
 */
export function detectFramework(pkg: Pkg, configs: Configs): SiteFramework | null {
  const deps = names(pkg);
  const build = scriptOf(pkg, "build") ?? "";

  if (deps.has("next")) {
    if (has(configs, "next.config", /output\s*:\s*["'`]export["'`]/)) {
      return { mode: "static", id: "next-export", label: "Next.js (static export)", output: ["out"], defaultBuild: ["next", "build"] };
    }
    return { mode: "server", id: "next", label: "Next.js" };
  }
  if (deps.has("nuxt")) {
    if (/\bnux[ti]\s+generate\b/.test(build) || has(configs, "nuxt.config", /\bssr\s*:\s*false\b/)) {
      return {
        mode: "static",
        id: "nuxt-generate",
        label: "Nuxt (generate)",
        output: [".output/public", "dist"],
        defaultBuild: ["nuxt", "generate"],
      };
    }
    return { mode: "server", id: "nuxt", label: "Nuxt" };
  }
  if (deps.has("@sveltejs/kit")) {
    if (deps.has("@sveltejs/adapter-static")) {
      return { mode: "static", id: "sveltekit-static", label: "SvelteKit (adapter-static)", output: ["build"], defaultBuild: ["vite", "build"] };
    }
    return { mode: "server", id: "sveltekit", label: "SvelteKit" };
  }
  if ([...deps].some((d) => d.startsWith("@remix-run/")) || deps.has("@react-router/dev")) {
    if (has(configs, "react-router.config", /\bssr\s*:\s*false\b/)) {
      return {
        mode: "static",
        id: "react-router-spa",
        label: "React Router (SPA mode)",
        output: ["build/client"],
        defaultBuild: ["react-router", "build"],
      };
    }
    return { mode: "server", id: "remix", label: "Remix / React Router" };
  }
  if (deps.has("astro")) {
    if (has(configs, "astro.config", /output\s*:\s*["'`](server|hybrid)["'`]/) || ASTRO_SERVER_ADAPTERS.some((a) => deps.has(a))) {
      return { mode: "server", id: "astro", label: "Astro (server)" };
    }
    return { mode: "static", id: "astro", label: "Astro", output: ["dist"], defaultBuild: ["astro", "build"] };
  }
  if (deps.has("gatsby")) {
    return { mode: "static", id: "gatsby", label: "Gatsby", output: ["public"], defaultBuild: ["gatsby", "build"] };
  }
  if (deps.has("@docusaurus/core")) {
    return { mode: "static", id: "docusaurus", label: "Docusaurus", output: ["build"], defaultBuild: ["docusaurus", "build"] };
  }
  if (deps.has("vitepress")) {
    return {
      mode: "static",
      id: "vitepress",
      label: "VitePress",
      output: ["docs/.vitepress/dist", ".vitepress/dist", "src/.vitepress/dist", "*/.vitepress/dist"],
      defaultBuild: ["vitepress", "build"],
    };
  }
  if (deps.has("@11ty/eleventy")) {
    return { mode: "static", id: "eleventy", label: "Eleventy", output: ["_site"], defaultBuild: ["eleventy"] };
  }
  if (deps.has("@angular/core")) {
    return { mode: "static", id: "angular", label: "Angular", output: ["dist/*/browser", "dist/*", "dist"], defaultBuild: ["ng", "build"] };
  }
  if (deps.has("react-scripts")) {
    return { mode: "static", id: "create-react-app", label: "Create React App", output: ["build"], defaultBuild: ["react-scripts", "build"] };
  }
  if (deps.has("vite")) {
    const flavour = ["react", "vue", "svelte", "solid-js", "preact", "lit"].find((d) => deps.has(d));
    const label = flavour ? `Vite (${flavour.replace("-js", "")})` : "Vite";
    return { mode: "static", id: flavour ? `vite-${flavour.replace("-js", "")}` : "vite", label, output: ["dist"], defaultBuild: ["vite", "build"] };
  }
  if (scriptOf(pkg, "build") && !scriptOf(pkg, "start")) {
    return { mode: "static", id: "generic", label: "an npm build script", output: GENERIC_OUTPUT, defaultBuild: [] };
  }
  return null;
}
