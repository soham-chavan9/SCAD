import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutodetectError, prepareBuildContext } from "./autodetect.js";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-detect-"));
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

describe("prepareBuildContext (T2.4 built-in templates)", () => {
  it("leaves an existing Dockerfile alone", async () => {
    const dir = await fixture({ Dockerfile: "FROM x\n", "package.json": "{}" });
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "dockerfile" });
    expect(await dockerfileOf(dir)).toBe("FROM x\n");
  });

  it("node: package.json with a start script runs npm start as a non-root user", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ scripts: { start: "node a.js" } }) });
    expect(await prepareBuildContext(dir, 3000)).toEqual({ kind: "node" });
    const df = await dockerfileOf(dir);
    expect(df).toMatch(/^FROM node:22-alpine/m);
    expect(df).toMatch(/^USER node$/m);
    expect(df).toContain("PORT=3000");
    expect(df).toContain('CMD ["npm","start"]');
    expect(df).not.toMatch(/npm (install|ci)/);
  });

  it("node: falls back to main, then server.js / index.js", async () => {
    const main = await fixture({ "package.json": JSON.stringify({ main: "src/app.js" }), "src/app.js": "" });
    await prepareBuildContext(main, 8080);
    expect(await dockerfileOf(main)).toContain('CMD ["node","src/app.js"]');
    const server = await fixture({ "package.json": "{}", "server.js": "" });
    await prepareBuildContext(server, 8080);
    expect(await dockerfileOf(server)).toContain('CMD ["node","server.js"]');
  });

  it("node: dependencies without vendored node_modules fail with a hint (builds are offline)", async () => {
    const dir = await fixture({
      "package.json": JSON.stringify({ scripts: { start: "node a.js" }, dependencies: { express: "^5" } }),
    });
    const err = await prepareBuildContext(dir, 8080).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutodetectError);
    expect((err as AutodetectError).envelope).toMatchObject({
      code: "BUILD_FAILED",
      hint: expect.stringMatching(/network|bundle|vendor/i),
    });
  });

  it("node: refuses a main path that escapes the app", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ main: "../../etc/passwd" }) });
    await expect(prepareBuildContext(dir, 8080)).rejects.toBeInstanceOf(AutodetectError);
  });

  it("node: invalid package.json is a BUILD_FAILED with a hint, not a crash", async () => {
    const dir = await fixture({ "package.json": "{ not json" });
    const err = (await prepareBuildContext(dir, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err.envelope).toMatchObject({ code: "BUILD_FAILED", hint: expect.stringContaining("package.json") });
  });

  it("python: requirements.txt with no packages runs app.py as nobody", async () => {
    const dir = await fixture({ "requirements.txt": "# stdlib only\n\n", "app.py": "" });
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "python" });
    const df = await dockerfileOf(dir);
    expect(df).toMatch(/^FROM python:3\.12-alpine/m);
    expect(df).toMatch(/^USER 65534:65534$/m);
    expect(df).toContain('CMD ["python","app.py"]');
    expect(df).not.toContain("pip install");
  });

  it("python: packages install offline from vendored wheels/", async () => {
    const dir = await fixture({ "requirements.txt": "flask==3.1.0\n", "main.py": "", "wheels/README": "" });
    await prepareBuildContext(dir, 8080);
    const df = await dockerfileOf(dir);
    expect(df).toContain("pip install --no-index --find-links /app/wheels");
    expect(df).toContain('CMD ["python","main.py"]');
  });

  it("python: packages without wheels/ fail with a hint", async () => {
    const dir = await fixture({ "requirements.txt": "flask==3.1.0\n", "app.py": "" });
    const err = (await prepareBuildContext(dir, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err).toBeInstanceOf(AutodetectError);
    expect(err.envelope.hint).toMatch(/wheels/);
  });

  it("python: no entry file is a BUILD_FAILED with a hint", async () => {
    const dir = await fixture({ "requirements.txt": "" });
    const err = (await prepareBuildContext(dir, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err.envelope.hint).toMatch(/app\.py/);
  });

  it("static: index.html is served by busybox httpd as nobody", async () => {
    const dir = await fixture({ "index.html": "<h1>hi</h1>" });
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "static" });
    const df = await dockerfileOf(dir);
    expect(df).toMatch(/^FROM busybox:1\.36/m);
    expect(df).toMatch(/^USER 65534:65534$/m);
    expect(df).toContain('"httpd","-f"');
    expect(df).toContain('"8080"');
  });

  it("nothing recognisable lists the supported layouts", async () => {
    const dir = await fixture({ "README.md": "hi" });
    const err = (await prepareBuildContext(dir, 8080).catch((e: unknown) => e)) as AutodetectError;
    expect(err.envelope).toMatchObject({ code: "BUILD_FAILED" });
    expect(err.envelope.hint).toMatch(/Dockerfile/);
    expect(err.envelope.hint).toMatch(/package\.json/);
    expect(err.envelope.hint).toMatch(/requirements\.txt/);
    expect(err.envelope.hint).toMatch(/index\.html/);
  });

  it("ignores a symlinked package.json (never follows links out of the context)", async () => {
    const dir = await fixture({ "index.html": "x" });
    await symlink("/etc/hosts", join(dir, "package.json"));
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "static" });
  });
});

describe("prepareBuildContext: site frameworks (T3.2)", () => {
  const vite = {
    "package.json": JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { react: "19.0.0" },
      devDependencies: { vite: "8.0.0" },
    }),
    "index.html": "<div id=root>",
  };

  it("a Vite site gets the npm fetch, an offline multi-stage build, and SCAD's static server", async () => {
    const dir = await fixture(vite);
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "site", framework: "vite-react", label: "Vite (react)", fetch: "npm" });
    const df = await dockerfileOf(dir);
    expect(df).toMatch(/^FROM node:22-alpine AS build$/m);
    expect(df).toContain("RUN npm run build");
    expect(df).toContain('mv "$d" .scad/site');
    expect(df).toContain('CMD ["node","/srv/scad-static-server.mjs","/site"]');
    expect(df.match(/^USER node$/gm)).toHaveLength(2); // build and runtime are non-root
    expect(df).toContain("PORT=8080");
    // The build never downloads anything itself (the fetch step did).
    expect(df).not.toMatch(/npm (install|ci)|curl|wget|apk add|pip install/);
    expect(await readFile(join(dir, ".scad", "static-server.mjs"), "utf8")).toContain("createStaticServer");
    // node_modules from the fetch step must reach the build context.
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toBe(".git\n");
  });

  it("replaces an upload's own .scad/ and .dockerignore (they could hide node_modules)", async () => {
    const dir = await fixture({ ...vite, ".dockerignore": "node_modules\n", ".scad/static-server.mjs": "evil" });
    await prepareBuildContext(dir, 8080);
    expect(await readFile(join(dir, ".dockerignore"), "utf8")).toBe(".git\n");
    expect(await readFile(join(dir, ".scad", "static-server.mjs"), "utf8")).not.toBe("evil");
  });

  it("without a build script, runs the framework's own build command", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ dependencies: { astro: "7.0.0" } }) });
    expect(await prepareBuildContext(dir, 8080)).toMatchObject({ kind: "site", framework: "astro" });
    expect(await dockerfileOf(dir)).toContain('RUN ["node_modules/.bin/astro","build"]');
  });

  it("an Angular site looks for dist/<project>/browser first", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ scripts: { build: "ng build" }, dependencies: { "@angular/core": "22.0.0" } }) });
    await prepareBuildContext(dir, 8080);
    expect(await dockerfileOf(dir)).toContain("for d in dist/*/browser dist/* dist;");
  });

  it("a Hugo site uses the verified Hugo binary and no fetch step", async () => {
    const fakeHugo = await fixture({ hugo: "\x7fELF" });
    const dir = await fixture({ "hugo.toml": 'title = "x"', "content/_index.md": "hi" });
    expect(await prepareBuildContext(dir, 8080, { hugoBinary: async () => join(fakeHugo, "hugo") })).toEqual({
      kind: "hugo",
      framework: "hugo",
      label: "Hugo",
    });
    expect((await stat(join(dir, ".scad", "hugo"))).mode & 0o111).not.toBe(0);
    expect(await dockerfileOf(dir)).toContain("RUN ./.scad/hugo --minify --baseURL / --destination .scad/site");
  });

  it("a Jekyll site fetches gems with bundler and builds offline from vendor/cache", async () => {
    const dir = await fixture({ Gemfile: 'gem "jekyll"', "_config.yml": "title: x", "index.md": "# hi" });
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "jekyll", framework: "jekyll", label: "Jekyll", fetch: "bundler" });
    const df = await dockerfileOf(dir);
    expect(df).toContain("RUN bundle install --local");
    expect(df).toContain("bundle exec jekyll build --destination .scad/site");
  });

  it("an unknown framework with a build script tries dist, build, out, public, _site", async () => {
    const dir = await fixture({ "package.json": JSON.stringify({ scripts: { build: "parcel build index.html" }, devDependencies: { parcel: "2.0.0" } }) });
    expect(await prepareBuildContext(dir, 8080)).toMatchObject({ kind: "site", framework: "generic", fetch: "npm" });
    expect(await dockerfileOf(dir)).toContain("for d in dist build out public _site;");
  });

  it("a plain index.html site keeps the T2.4 busybox template (no fetch)", async () => {
    const dir = await fixture({ "index.html": "<h1>hi</h1>" });
    expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "static" });
  });
});
