// SCAD (T3.3): lets `next/font/google` build with no network.
//
// Next.js reads NEXT_FONT_GOOGLE_MOCKED_RESPONSES (a module mapping Google
// Fonts CSS URLs to CSS) instead of calling fonts.googleapis.com, and reads
// font files given as absolute paths from disk. SCAD's trusted fetch step
// downloads the same fonts from the npm registry (@fontsource packages) into
// .scad/fonts; this module answers each CSS request from those files.
/* eslint-disable @typescript-eslint/no-require-imports -- Next.js require()s this file as CommonJS */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "fonts", "node_modules");

function fontPackage(slug) {
  for (const scope of ["@fontsource-variable", "@fontsource"]) {
    const dir = path.join(ROOT, scope, slug, "files");
    if (fs.existsSync(dir)) return { dir, variable: scope === "@fontsource-variable" };
  }
  return null;
}

function variantsOf(spec) {
  // "wght@100..900", "ital,wght@0,400;1,700", "" (defaults)
  if (!spec.includes("@")) return [["normal", "400"]];
  const [keys, values] = spec.split("@");
  const names = keys.split(",");
  return values.split(";").map((tuple) => {
    const parts = tuple.split(",");
    const ital = names.indexOf("ital");
    const wght = names.indexOf("wght");
    return [ital >= 0 && parts[ital] === "1" ? "italic" : "normal", wght >= 0 ? parts[wght] : "400"];
  });
}

function cssFor(url) {
  const u = new URL(url);
  const display = u.searchParams.get("display") || "swap";
  const out = [];
  for (const familySpec of u.searchParams.getAll("family")) {
    const [name, spec = ""] = familySpec.split(":");
    const family = name.replace(/\+/g, " ");
    const slug = family.toLowerCase().replace(/\s+/g, "-");
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) return undefined;
    const pkg = fontPackage(slug);
    if (!pkg) return undefined;
    const files = fs.readdirSync(pkg.dir).filter((f) => f.endsWith(".woff2"));
    const fileRe = new RegExp(`^${slug}-(.+)-(wght|\\d+)-(normal|italic)\\.woff2$`);
    for (const [style, weight] of variantsOf(spec)) {
      for (const file of files) {
        const m = fileRe.exec(file);
        if (!m || m[3] !== style) continue;
        if (pkg.variable ? m[2] !== "wght" : m[2] !== weight.split("..")[0]) continue;
        out.push(
          `/* ${m[1]} */`,
          "@font-face {",
          `  font-family: '${family}';`,
          `  font-style: ${style};`,
          `  font-weight: ${weight.replace("..", " ")};`,
          `  font-display: ${display};`,
          `  src: url(${path.join(pkg.dir, file)}) format('woff2');`,
          "}",
        );
      }
    }
  }
  return out.length > 0 ? out.join("\n") + "\n" : undefined;
}

module.exports = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== "string" || !key.startsWith("https://fonts.googleapis.com/")) return undefined;
      return cssFor(key);
    },
  },
);
