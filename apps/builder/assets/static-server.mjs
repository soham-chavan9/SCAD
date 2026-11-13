// SCAD static site server (T3.2). Copied into images built from a site
// framework (Vite, Astro, Docusaurus, Hugo, ...). No dependencies.
//
//   node static-server.mjs <root>
//
// - GET/HEAD only; never serves anything outside <root>.
// - `/a` tries a, a.html, a/index.html (a directory redirects to `/a/`).
// - Misses: when <root>/404.html exists (multi-page sites), it is served with
//   404. Otherwise a page navigation gets index.html with 200, so
//   client-side routes of single-page apps survive a reload.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

async function fileAt(path) {
  try {
    const st = await stat(path);
    if (st.isFile()) return st;
    return st.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

export function createStaticServer(rootDir) {
  const root = resolve(rootDir);
  const inside = (p) => p === root || p.startsWith(root + sep);

  function send(req, res, status, path, size) {
    const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(status, {
      "content-type": type,
      "content-length": String(size),
      "x-content-type-options": "nosniff",
      "cache-control": type.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(path)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  const text = (res, status, body, headers = {}) =>
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers }).end(body);

  return createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      text(res, 405, "Method Not Allowed\n", { allow: "GET, HEAD" });
      return;
    }
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const rawPath = q === -1 ? url : url.slice(0, q);
    const query = q === -1 ? "" : url.slice(q);
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath || "/");
    } catch {
      text(res, 400, "Bad Request\n");
      return;
    }
    if (pathname.includes("\0") || !pathname.startsWith("/")) {
      text(res, 400, "Bad Request\n");
      return;
    }
    const target = resolve(join(root, pathname));
    if (!inside(target)) {
      text(res, 404, "Not Found\n");
      return;
    }

    const exact = await fileAt(target);
    if (exact && exact !== "dir") return send(req, res, 200, target, exact.size);
    if (exact === "dir") {
      const index = join(target, "index.html");
      const st = await fileAt(index);
      if (st && st !== "dir") {
        if (!pathname.endsWith("/")) {
          res.writeHead(301, { location: `${rawPath}/${query}` }).end();
          return;
        }
        return send(req, res, 200, index, st.size);
      }
    }
    if (pathname !== "/" && !extname(pathname.replace(/\/$/, ""))) {
      const html = `${target.replace(/[/\\]$/, "")}.html`;
      const st = await fileAt(html);
      if (st && st !== "dir") return send(req, res, 200, html, st.size);
    }

    const notFound = join(root, "404.html");
    const nf = await fileAt(notFound);
    if (nf && nf !== "dir") return send(req, res, 404, notFound, nf.size);
    const ext = extname(pathname);
    const index = join(root, "index.html");
    const ix = await fileAt(index);
    if ((ext === "" || ext === ".html") && ix && ix !== "dir") return send(req, res, 200, index, ix.size);
    text(res, 404, "Not Found\n");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ?? "/site";
  const port = Number(process.env.PORT ?? 8080);
  createStaticServer(root).listen(port, "0.0.0.0", () => {
    console.log(`scad static server: serving ${root} on port ${port}`);
  });
}
