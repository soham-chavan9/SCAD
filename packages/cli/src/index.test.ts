import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { ScadApiError } from "@scad/api-client";
import {
  createPublishTarball,
  openApp,
  PACKAGE_NAME,
  publishDir,
  PUBLISH_MAX_BYTES,
  saveConfig,
} from "./index.js";

describe("@scad/cli", () => {
  it("exports helpers", () => {
    expect(PACKAGE_NAME).toBe("cli");
    expect(PUBLISH_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it("createPublishTarball respects .gitignore and .scadignore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-tar-"));
    await writeFile(join(dir, "keep.js"), "ok");
    await writeFile(join(dir, ".gitignore"), "skip-git.txt\n");
    await writeFile(join(dir, ".scadignore"), "skip-scad.txt\n");
    await writeFile(join(dir, "skip-git.txt"), "no");
    await writeFile(join(dir, "skip-scad.txt"), "no");
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "x.js"), "no");

    const tarBuf = await createPublishTarball(dir);
    const entries: string[] = [];
    const tmpTar = join(dir, "out.tar");
    await writeFile(tmpTar, tarBuf);
    await tar.t({
      file: tmpTar,
      onentry: (e) => {
        entries.push(e.path.replace(/\/$/, ""));
      },
    });

    expect(entries).toContain("keep.js");
    expect(entries).not.toContain("skip-git.txt");
    expect(entries).not.toContain("skip-scad.txt");
    expect(entries.some((e) => e.startsWith("node_modules"))).toBe(false);
    expect(entries).not.toContain(".gitignore");
    expect(entries).not.toContain(".scadignore");
  });

  it("publishDir prints a final URL with no braces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-pub-"));
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    const configPath = join(dir, "config.json");
    await saveConfig({ apiUrl: "http://cp.test", pat: "pat-test" }, configPath);

    const finalUrl = "http://hello-node.alice.localhost:8080";
    const status: string[] = [];
    let releaseCalls = 0;

    const result = await publishDir({
      dir,
      name: "hello-node",
      configPath,
      pollMs: 1,
      onStatus: (line) => status.push(line),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/apps/publish") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              app: { id: "app-1", slug: "hello-node", ownerId: "u1", status: "building" },
              release: { id: "rel-1", version: 1, status: "building" },
              url: finalUrl,
            }),
            { status: 202, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/v1/releases/rel-1")) {
          releaseCalls += 1;
          return new Response(
            JSON.stringify({
              id: "rel-1",
              appId: "app-1",
              version: 1,
              status: "ready",
              imageRef: "img",
              error: null,
              log_tail: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    expect(result.url).toBe(finalUrl);
    expect(result.url).not.toMatch(/[{}]/);
    expect(status.some((l) => l.includes(finalUrl))).toBe(true);
    expect(status.every((l) => !l.includes("{") && !l.includes("}"))).toBe(true);
    expect(releaseCalls).toBeGreaterThan(0);
  });

  it("publishDir --public sets the link public and says so; a new app is private otherwise (T3.5)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-pub-vis-"));
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    const configPath = join(dir, "config.json");
    await saveConfig({ apiUrl: "http://cp.test", pat: "pat-test" }, configPath);
    const patches: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith("/v1/apps/publish")) {
        return json(
          {
            app: { id: "app-1", slug: "site", ownerId: "u1", status: "building", visibility: "allowlist" },
            release: { id: "rel-1", version: 1, status: "building" },
            url: "http://site.alice.localhost:8080",
          },
          202,
        );
      }
      if (url.endsWith("/v1/apps/app-1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { visibility: string };
        patches.push(body);
        return json({ app: { id: "app-1", slug: "site", visibility: body.visibility } });
      }
      if (url.includes("/v1/releases/rel-1")) {
        return json({ id: "rel-1", appId: "app-1", version: 1, status: "ready", imageRef: "i", error: null, log_tail: [] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const pub = await publishDir({ dir, name: "site", configPath, pollMs: 1, visibility: "public", fetchImpl });
    expect(patches).toEqual([{ visibility: "public" }]);
    expect(pub.visibility).toBe("public");
    expect(pub.link).toMatch(/^Public link: anyone with the link/);

    patches.length = 0;
    const priv = await publishDir({ dir, name: "site", configPath, pollMs: 1, fetchImpl });
    expect(patches).toEqual([]);
    expect(priv.visibility).toBe("allowlist");
    expect(priv.link).toMatch(/^Private link/);
  });

  it("publishDir fails with structured error when URL is a template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-pub-bad-"));
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    const configPath = join(dir, "config.json");
    await saveConfig({ apiUrl: "http://cp.test", pat: "pat-test" }, configPath);

    let thrown: unknown;
    try {
      await publishDir({
        dir,
        name: "hello-node",
        configPath,
        pollMs: 1,
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify({
                app: { id: "app-1", slug: "hello-node", ownerId: "u1", status: "building" },
                release: { id: "rel-1", version: 1, status: "building" },
                url: "http://{slug}.{owner}.localhost:8080",
              }),
              { status: 202, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ScadApiError);
    const envelope = (thrown as ScadApiError).envelope;
    expect(envelope).toMatchObject({
      code: "INTERNAL",
      message: "Could not determine the app host URL",
    });
    expect(JSON.stringify(envelope)).not.toMatch(/\{slug\}|\{owner\}/);
  });

  it("openApp opens the resolved final URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-open-"));
    const configPath = join(dir, "config.json");
    await saveConfig({ apiUrl: "http://cp.test", pat: "pat-test" }, configPath);
    const opened: string[] = [];

    const result = await openApp({
      app: "hello-node",
      configPath,
      openUrl: async (url) => {
        opened.push(url);
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toContain("/v1/apps/hello-node");
        return new Response(
          JSON.stringify({
            app: {
              id: "app-1",
              slug: "hello-node",
              ownerId: "u1",
              status: "running",
              visibility: "allowlist",
              createdAt: new Date().toISOString(),
              expiresAt: null,
              lastViewedAt: null,
              url: "http://hello-node.alice.localhost:8080",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(result.url).toBe("http://hello-node.alice.localhost:8080");
    expect(result.url).not.toMatch(/[{}]/);
    expect(opened).toEqual(["http://hello-node.alice.localhost:8080"]);
  });

  it("openApp fails with structured error when host URL is a template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-open-bad-"));
    const configPath = join(dir, "config.json");
    await saveConfig({ apiUrl: "http://cp.test", pat: "pat-test" }, configPath);

    let thrown: unknown;
    try {
      await openApp({
        app: "hello-node",
        configPath,
        openUrl: async () => undefined,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              app: {
                id: "app-1",
                slug: "hello-node",
                ownerId: "u1",
                status: "running",
                visibility: "allowlist",
                createdAt: new Date().toISOString(),
                expiresAt: null,
                lastViewedAt: null,
                url: "http://{slug}.{owner}.localhost:8080",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ScadApiError);
    const envelope = (thrown as ScadApiError).envelope;
    expect(envelope).toMatchObject({ code: "INTERNAL" });
    expect(JSON.stringify(envelope)).not.toMatch(/\{slug\}|\{owner\}/);
  });
});
