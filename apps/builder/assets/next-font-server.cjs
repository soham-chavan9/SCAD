// SCAD (T3.3): serves the fonts the trusted fetch step downloaded, on
// 127.0.0.1 only, while `next build` runs. Turbopack downloads font files
// itself even when the Google Fonts CSS is mocked; the build has no network,
// but loopback works, so it fetches them from here. Nothing leaves the build.
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS run with node */
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(process.argv[2] || "/home/node/app/.scad/fonts/node_modules");
const PORT = Number(process.argv[3] || 47123);

http
  .createServer((req, res) => {
    const file = path.resolve(path.join(ROOT, decodeURIComponent((req.url || "/").split("?")[0])));
    if (!file.startsWith(ROOT + path.sep) || !file.endsWith(".woff2") || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "font/woff2" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1");
