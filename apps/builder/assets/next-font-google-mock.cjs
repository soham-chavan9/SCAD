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

// Turbopack bundles and evaluates this file itself, so use absolute paths
// (SCAD builds in /home/node/app) and plain file reads, no dynamic require.
const APP = "/home/node/app";
const ROOT = fs.existsSync(path.join(APP, ".scad", "fonts")) ? path.join(APP, ".scad", "fonts", "node_modules") : path.join(__dirname, "fonts", "node_modules");
// Webpack reads absolute paths from disk; Turbopack always downloads font
// files, so under Turbopack they come from SCAD's loopback font server
// (assets/next-font-server.cjs), started for the build only.
const FONT_SERVER = "http://127.0.0.1:47123";
const fontUrl = (file) => (process.env.TURBOPACK ? `${FONT_SERVER}/${path.relative(ROOT, file).split(path.sep).join("/")}` : file);
const FONT_DATA = "node_modules/next/dist/compiled/@next/font/dist/google/font-data.json";

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
          `  src: url(${fontUrl(path.join(pkg.dir, file))}) format('woff2');`,
          "}",
        );
      }
    }
  }
  return out.length > 0 ? out.join("\n") + "\n" : undefined;
}

/**
 * Turbopack reads this module as a plain object (by key), webpack looks keys
 * up one at a time. So export the URLs Next builds for each installed font,
 * precomputed from Next's own font data (variable weight ranges, with and
 * without italics, every `display`), and answer anything else lazily.
 */
function precomputed() {
  const table = {};
  let fontData = {};
  for (const base of [APP, process.cwd()]) {
    try {
      fontData = JSON.parse(fs.readFileSync(path.join(base, FONT_DATA), "utf8"));
      break;
    } catch {
      // try the next location
    }
  }
  for (const [family, data] of Object.entries(fontData)) {
    const slug = family.toLowerCase().replace(/\s+/g, "-");
    if (!fontPackage(slug)) continue;
    const name = family.replace(/ /g, "+");
    const wght = (data.axes || []).find((a) => a.tag === "wght");
    const specs = [""];
    if (wght) {
      const range = `${wght.min}..${wght.max}`;
      specs.push(`:wght@${range}`, `:ital,wght@0,${range};1,${range}`);
    }
    for (const w of data.weights || []) {
      if (w !== "variable") specs.push(`:wght@${w}`, `:ital,wght@0,${w};1,${w}`);
    }
    for (const spec of specs) {
      for (const display of ["auto", "block", "swap", "fallback", "optional"]) {
        const url = `https://fonts.googleapis.com/css2?family=${name}${spec}&display=${display}`;
        const css = cssFor(url);
        if (css) table[url] = css;
      }
    }
  }
  return table;
}

module.exports = new Proxy(precomputed(), {
  get(target, key) {
    if (typeof key !== "string") return undefined;
    if (key in target) return target[key];
    if (!key.startsWith("https://fonts.googleapis.com/")) return undefined;
    return cssFor(key);
  },
});
