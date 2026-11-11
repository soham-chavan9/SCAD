import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutodetectError, prepareBuildContext } from "./autodetect.js";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-ssr-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}
const dockerfileOf = (dir: string) => readFile(join(dir, "Dockerfile"), "utf8");
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const pkg = (p: object) => JSON.stringify(p);

/** What every server-rendered template must keep: offline build, non-root runtime, PORT, no downloads. */
function expectHardenedServer(df: string, port: number) {
  expect(df).toMatch(/^FROM node:22-alpine AS build$/m);
  expect(df.match(/^USER node$/gm)).toHaveLength(2);
  expect(df).toContain(`PORT=${port}`);
  expect(df).toContain("HOST=0.0.0.0");
  expect(df).not.toMatch(/npm (install|ci)\b|curl|wget|apk add/);
}

describe("prepareBuildContext: server-rendered sites (T3.3)", () => {
  it("Next.js runs next start with production node_modules (no config change needed)", async () => {
    const dir = await fixture({ "package.json": pkg({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "16.0.0" } }) });
    expect(await prepareBuildContext(dir, 3000)).toMatchObject({ kind: "server-site", framework: "next", fetch: "npm" });
    const df = await dockerfileOf(dir);
    expectHardenedServer(df, 3000);
    expect(df).toContain("RUN npm prune --omit=dev");
    expect(df).toContain("ln -s /tmp/next-cache .next/cache"); // read-only root
    expect(df).toContain('CMD ["node_modules/.bin/next","start"]');
  });

  it("Next.js with output: 'standalone' runs the standalone server", async () => {
    const dir = await fixture({
      "package.json": pkg({ scripts: { build: "next build" }, dependencies: { next: "16.0.0" } }),
      "next.config.ts": 'export default { output: "standalone" }',
    });
    await prepareBuildContext(dir, 8080);
    const df = await dockerfileOf(dir);
    expect(df).toContain("COPY --from=build --chown=node:node /home/node/app/.next/standalone /home/node/app");
    expect(df).toContain('CMD ["node","server.js"]');
  });

  it("Nuxt runs the self-contained Nitro server", async () => {
    const dir = await fixture({ "package.json": pkg({ scripts: { build: "nuxt build" }, dependencies: { nuxt: "4.0.0" } }) });
    expect(await prepareBuildContext(dir, 8080)).toMatchObject({ framework: "nuxt" });
    const df = await dockerfileOf(dir);
    expectHardenedServer(df, 8080);
    expect(df).toContain('CMD ["node",".output/server/index.mjs"]');
  });

  it("SvelteKit with adapter-auto gets adapter-node in the build, founder files unchanged", async () => {
    const vite = 'import adapter from "@sveltejs/adapter-auto";\nexport default {};\n';
    const dir = await fixture({
      "package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { "@sveltejs/kit": "3.2.0", "@sveltejs/adapter-auto": "8.0.1" } }),
      "vite.config.js": vite,
    });
    const plan = await prepareBuildContext(dir, 8080);
    expect(plan).toMatchObject({ framework: "sveltekit", extraDependencies: { "@sveltejs/adapter-node": "6.0.2" } });
    expect(plan.note).toMatch(/unchanged/);
    expect(await readFile(join(dir, "vite.config.js"), "utf8")).toBe(vite);
    const df = await dockerfileOf(dir);
    expectHardenedServer(df, 8080);
    expect(df).toContain('export { default } from "@sveltejs/adapter-node";');
    expect(df.indexOf("adapter-auto/index.js")).toBeLessThan(df.indexOf("RUN npm run build"));
    expect(df).toContain('CMD ["node","build"]');
  });

  it("SvelteKit with adapter-node needs nothing extra; another platform adapter gets a hint", async () => {
    const node = await fixture({ "package.json": pkg({ devDependencies: { "@sveltejs/kit": "3.2.0", "@sveltejs/adapter-node": "6.0.2" } }) });
    const plan = await prepareBuildContext(node, 8080);
    expect(plan.extraDependencies).toBeUndefined();
    expect(await dockerfileOf(node)).not.toContain("adapter-auto");
    const vercel = await fixture({ "package.json": pkg({ devDependencies: { "@sveltejs/kit": "3.2.0", "@sveltejs/adapter-vercel": "6.0.0" } }) });
    const err = (await prepareBuildContext(vercel, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err).toBeInstanceOf(AutodetectError);
    expect(err.envelope.hint).toContain("@sveltejs/adapter-node");
  });

  it("Remix / React Router uses npm start (react-router-serve)", async () => {
    const dir = await fixture({
      "package.json": pkg({
        scripts: { build: "react-router build", start: "react-router-serve ./build/server/index.js" },
        dependencies: { "@react-router/serve": "8.0.0", "react-router": "8.0.0" },
        devDependencies: { "@react-router/dev": "8.0.0" },
      }),
    });
    expect(await prepareBuildContext(dir, 8080)).toMatchObject({ framework: "remix" });
    const df = await dockerfileOf(dir);
    expectHardenedServer(df, 8080);
    expect(df).toContain('CMD ["npm","start"]');
  });

  it("Astro with the Node adapter runs dist/server/entry.mjs; without it, a hint", async () => {
    const dir = await fixture({
      "package.json": pkg({ scripts: { build: "astro build" }, dependencies: { astro: "7.0.0", "@astrojs/node": "11.0.0" } }),
      "astro.config.mjs": 'export default { output: "server", adapter: node({ mode: "standalone" }) }',
    });
    expect(await prepareBuildContext(dir, 8080)).toMatchObject({ framework: "astro", kind: "server-site" });
    expect(await dockerfileOf(dir)).toContain('CMD ["node","dist/server/entry.mjs"]');
    const vercel = await fixture({
      "package.json": pkg({ dependencies: { astro: "7.0.0", "@astrojs/vercel": "9.0.0" } }),
    });
    const err = (await prepareBuildContext(vercel, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err.envelope.hint).toContain("@astrojs/node");
  });

  it("a backend app (Express server, no site framework) gets the M4 hint", async () => {
    const dir = await fixture({ "package.json": pkg({ scripts: { start: "node server.js" }, dependencies: { express: "5.0.0" } }), "server.js": "" });
    const err = (await prepareBuildContext(dir, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err).toBeInstanceOf(AutodetectError);
    expect(err.message).toMatch(/backend app/);
    expect(err.envelope.hint).toMatch(/M4/);
    expect(err.envelope.details).toMatchObject({ backend: true });
  });

  it("a Flask app with packages and no wheels mentions M4", async () => {
    const dir = await fixture({ "requirements.txt": "flask==3.1.0\n", "app.py": "" });
    const err = (await prepareBuildContext(dir, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err.envelope.hint).toMatch(/M4/);
  });

  it("next/font/google: fonts come from the fetch step and a loopback-only font server during the build", async () => {
    const dir = await fixture({
      "package.json": pkg({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "16.0.0" } }),
      "app/layout.tsx": 'import { Geist, Geist_Mono } from "next/font/google";',
    });
    expect(await prepareBuildContext(dir, 8080)).toMatchObject({ framework: "next", googleFonts: ["geist", "geist-mono"] });
    const df = await dockerfileOf(dir);
    expect(df).toContain("ENV NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/home/node/app/.scad/next-font-google-mock.cjs");
    expect(df).toContain("RUN node .scad/next-font-server.cjs & p=$!; npm run build; s=$?; kill $p; exit $s");
    expect(await readFile(join(dir, ".scad", "next-font-server.cjs"), "utf8")).toContain('listen(PORT, "127.0.0.1")');
  });
});

