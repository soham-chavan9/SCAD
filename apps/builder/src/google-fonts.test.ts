import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGoogleFonts, fontSlug, fontsInSource } from "./google-fonts.js";

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-fonts-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("next/font/google detection (T3.3)", () => {
  it("reads font imports as text, the way create-next-app writes them", () => {
    expect(fontsInSource('import { Geist, Geist_Mono } from "next/font/google";')).toEqual(["geist", "geist-mono"]);
    expect(fontsInSource("import {\n  Inter as Sans,\n} from 'next/font/google'")).toEqual(["inter"]);
    expect(fontsInSource('import localFont from "next/font/local";')).toEqual([]);
    expect(fontSlug("Roboto_Slab")).toBe("roboto-slab");
    expect(fontSlug("$(touch x)")).toBeNull();
  });

  it("scans app/, src/, ... and skips node_modules", async () => {
    const dir = await fixture({
      "app/layout.tsx": 'import { Geist, Geist_Mono } from "next/font/google";',
      "src/components/x.jsx": "import { Inter } from 'next/font/google'",
      "node_modules/pkg/index.js": 'import { Lobster } from "next/font/google";',
    });
    expect(await findGoogleFonts(dir)).toEqual(["geist", "geist-mono", "inter"]);
  });
});

describe("next-font-google-mock.cjs", () => {
  it("answers Next's Google Fonts CSS URLs from @fontsource files on disk", async () => {
    const root = await fixture({
      "fonts/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2": "x",
      "fonts/node_modules/@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2": "x",
      "fonts/node_modules/@fontsource-variable/geist/files/geist-latin-wght-italic.woff2": "x",
      "fonts/node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff2": "x",
      "fonts/node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff2": "x",
    });
    const mockPath = join(root, "next-font-google-mock.cjs");
    await writeFile(mockPath, await readFile(new URL("../assets/next-font-google-mock.cjs", import.meta.url)));
    const mock = createRequire(import.meta.url)(mockPath) as Record<string, string | undefined>;

    const geist = mock["https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap"]!;
    expect(geist).toContain("/* latin */");
    expect(geist).toContain("/* latin-ext */");
    expect(geist).toContain("font-family: 'Geist';");
    expect(geist).toContain("font-weight: 100 900;");
    expect(geist).toMatch(/src: url\(\/.*geist-latin-wght-normal\.woff2\) format\('woff2'\);/);
    expect(geist).not.toContain("italic.woff2");

    const roboto = mock["https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap"]!;
    expect(roboto).toContain("roboto-latin-400-normal.woff2");
    expect(roboto).toContain("roboto-latin-700-normal.woff2");

    expect(mock["https://fonts.googleapis.com/css2?family=Lobster&display=swap"]).toBeUndefined();
    expect(mock["https://evil.example/"]).toBeUndefined();
  });
});
