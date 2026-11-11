import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * T3.3: `next/font/google` downloads fonts during `next build`, which has no
 * network. SCAD finds the fonts a Next.js project imports (by reading source
 * files as text, never running them); the trusted fetch step downloads the
 * same fonts from the npm registry (`@fontsource-variable/<font>`, else
 * `@fontsource/<font>`), and `assets/next-font-google-mock.cjs` serves them
 * to Next through its NEXT_FONT_GOOGLE_MOCKED_RESPONSES hook.
 */
const SOURCE_DIRS = ["app", "src", "pages", "components", "lib", "styles"];
const SOURCE_EXT = /\.(m?[jt]sx?|cjs)$/;
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/g;
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FONTS = 10;

/** `Geist_Mono` -> `geist-mono` (the @fontsource package name). */
export function fontSlug(importName: string): string | null {
  const slug = importName.trim().replace(/_/g, "-").toLowerCase();
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 60 ? slug : null;
}

export function fontsInSource(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0] ?? "";
      if (name === "" || name === "type") continue;
      const slug = fontSlug(name);
      if (slug) found.push(slug);
    }
  }
  return found;
}

/** Slugs of the Google fonts a Next.js project imports (at most {@link MAX_FONTS}). */
export async function findGoogleFonts(dir: string): Promise<string[]> {
  const fonts = new Set<string>();
  let files = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 8 || files > MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(path, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        files++;
        if ((await lstat(p)).size > MAX_FILE_BYTES) continue;
        for (const slug of fontsInSource(await readFile(p, "utf8"))) fonts.add(slug);
      }
    }
  };
  for (const d of SOURCE_DIRS) await walk(join(dir, d), 0);
  return [...fonts].sort().slice(0, MAX_FONTS);
}
