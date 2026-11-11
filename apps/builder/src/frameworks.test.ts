import { describe, expect, it } from "vitest";
import { detectFramework, GENERIC_OUTPUT } from "./frameworks.js";

const dev = (...names: string[]) => Object.fromEntries(names.map((n) => [n, "1.0.0"]));
const build = { build: "x build" };

describe("detectFramework (T3.2)", () => {
  it.each([
    [{ devDependencies: dev("vite"), dependencies: dev("react") }, "vite-react", ["dist"]],
    [{ devDependencies: dev("vite"), dependencies: dev("vue") }, "vite-vue", ["dist"]],
    [{ devDependencies: dev("vite", "svelte") }, "vite-svelte", ["dist"]],
    [{ devDependencies: dev("vite"), dependencies: dev("solid-js") }, "vite-solid", ["dist"]],
    [{ devDependencies: dev("vite"), dependencies: dev("preact") }, "vite-preact", ["dist"]],
    [{ dependencies: dev("react-scripts", "react") }, "create-react-app", ["build"]],
    [{ dependencies: dev("@angular/core") }, "angular", ["dist/*/browser", "dist/*", "dist"]],
    [{ dependencies: dev("astro") }, "astro", ["dist"]],
    [{ dependencies: dev("gatsby") }, "gatsby", ["public"]],
    [{ dependencies: dev("@docusaurus/core") }, "docusaurus", ["build"]],
    [{ devDependencies: dev("@11ty/eleventy") }, "eleventy", ["_site"]],
    [{ devDependencies: dev("@sveltejs/kit", "@sveltejs/adapter-static") }, "sveltekit-static", ["build"]],
  ])("%j -> %s", (pkg, id, output) => {
    const site = detectFramework({ ...pkg, scripts: build }, {});
    expect(site).toMatchObject({ mode: "static", id, output });
  });

  it("VitePress output lives under .vitepress/dist", () => {
    const site = detectFramework({ devDependencies: dev("vitepress", "vue") }, {});
    expect(site).toMatchObject({ id: "vitepress" });
    expect(site?.mode === "static" && site.output).toContain("docs/.vitepress/dist");
  });

  it("Next.js is a static export only with output: 'export'", () => {
    const pkg = { dependencies: dev("next", "react") };
    expect(detectFramework(pkg, { "next.config.mjs": 'export default { output: "export" }' })).toMatchObject({
      mode: "static",
      id: "next-export",
      output: ["out"],
    });
    expect(detectFramework(pkg, { "next.config.ts": "export default { reactStrictMode: true }" })).toMatchObject({
      mode: "server",
      id: "next",
    });
  });

  it("Nuxt generate is static; plain Nuxt renders on a server", () => {
    expect(detectFramework({ dependencies: dev("nuxt"), scripts: { build: "nuxt generate" } }, {})).toMatchObject({
      mode: "static",
      output: [".output/public", "dist"],
    });
    expect(detectFramework({ dependencies: dev("nuxt"), scripts: { build: "nuxt build" } }, {})).toMatchObject({ mode: "server" });
  });

  it("Astro with a server adapter or output: 'server' renders on a server", () => {
    expect(detectFramework({ dependencies: dev("astro", "@astrojs/node") }, {})).toMatchObject({ mode: "server", id: "astro" });
    expect(
      detectFramework({ dependencies: dev("astro") }, { "astro.config.mjs": "export default defineConfig({ output: 'server' })" }),
    ).toMatchObject({ mode: "server" });
  });

  it("SvelteKit without adapter-static and Remix / React Router are server sites", () => {
    expect(detectFramework({ devDependencies: dev("@sveltejs/kit", "@sveltejs/adapter-node") }, {})).toMatchObject({ mode: "server", id: "sveltekit" });
    expect(detectFramework({ devDependencies: dev("@react-router/dev", "vite") }, {})).toMatchObject({ mode: "server", id: "remix" });
    expect(detectFramework({ dependencies: dev("@remix-run/node") }, {})).toMatchObject({ mode: "server", id: "remix" });
    expect(
      detectFramework({ devDependencies: dev("@react-router/dev") }, { "react-router.config.ts": "export default { ssr: false }" }),
    ).toMatchObject({ mode: "static", output: ["build/client"] });
  });

  it("unknown framework with a build script falls back to the generic output folders", () => {
    expect(detectFramework({ devDependencies: dev("parcel"), scripts: { build: "parcel build" } }, {})).toMatchObject({
      mode: "static",
      id: "generic",
      output: GENERIC_OUTPUT,
    });
    expect(GENERIC_OUTPUT).toEqual(["dist", "build", "out", "public", "_site"]);
  });

  it("a plain Node server (start script, no site framework) is not a site", () => {
    expect(detectFramework({ dependencies: dev("express"), scripts: { start: "node server.js" } }, {})).toBeNull();
    expect(detectFramework({ scripts: { start: "node a.js", build: "tsc" } }, {})).toBeNull();
    expect(detectFramework({}, {})).toBeNull();
  });
});
