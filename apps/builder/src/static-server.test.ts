import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JS module shipped into site images
import { createStaticServer } from "../assets/static-server.mjs";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function serve(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scad-site-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), body);
  }
  const server = (createStaticServer as (root: string) => Server)(root);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("SCAD static server (T3.2)", () => {
  it("single-page apps: a client-side route reloads with index.html and 200", async () => {
    const base = await serve({ "index.html": "<div id=root>", "assets/app.js": "x" });
    const res = await fetch(`${base}/about/team?tab=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe("<div id=root>");
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
    // A missing asset is a real 404, not the app shell.
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it("multi-page sites: page.html, dir/index.html, and the site's own 404.html", async () => {
    const base = await serve({
      "index.html": "home",
      "about.html": "about",
      "docs/index.html": "docs",
      "404.html": "custom 404",
    });
    expect(await (await fetch(`${base}/about`)).text()).toBe("about");
    expect(await (await fetch(`${base}/about/`)).text()).toBe("about");
    const redirect = await fetch(`${base}/docs?x=1`, { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/docs/?x=1");
    expect(await (await fetch(`${base}/docs/`)).text()).toBe("docs");
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("custom 404");
  });

  it("never serves files outside the site root and only allows GET/HEAD", async () => {
    const base = await serve({ "index.html": "home" });
    for (const path of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc%2fpasswd"]) {
      const res = await fetch(`${base}${path}`);
      expect(await res.text()).not.toContain("root:");
    }
    expect((await fetch(`${base}/%00`)).status).toBe(400);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/`, { method: "HEAD" })).status).toBe(200);
  });
});
