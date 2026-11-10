import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
