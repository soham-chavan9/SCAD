#!/usr/bin/env node
// Build the one-file SCAD client (CLI + MCP server) that the control plane
// serves at /install/scad.mjs (T3.4). Usage: pnpm build:install [outfile]
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(process.argv[2] ?? join(root, "dist/install/scad.mjs"));
await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(root, "scripts/scad-bundle-entry.mjs")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
  // Some dependencies are CommonJS and call require() for Node built-ins.
  banner: { js: "import { createRequire as __scadRequire } from 'node:module'; const require = __scadRequire(import.meta.url);" },
});
console.log(`wrote ${outfile}`);
