import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore from "ignore";
import * as tar from "tar";

const MAX_BYTES = 100 * 1024 * 1024;

async function loadIgnore(dir: string) {
  const ig = ignore();
  ig.add([".git/", "node_modules/", ".scad/", ".gitignore", ".scadignore"]);
  for (const name of [".gitignore", ".scadignore"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    ig.add(text);
  }
  return ig;
}

function listFiles(dir: string, ig: ReturnType<typeof ignore>): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      const rel = relative(dir, abs).split(sep).join("/");
      if (ig.ignores(rel) || (entry.isDirectory() && ig.ignores(`${rel}/`))) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

export async function createPublishTarball(dir: string): Promise<Buffer> {
  const ig = await loadIgnore(dir);
  const files = listFiles(dir, ig);
  if (files.length === 0) {
    throw new Error("Nothing to publish (directory empty after ignores)");
  }

  let total = 0;
  for (const rel of files) {
    total += statSync(join(dir, rel)).size;
    if (total > MAX_BYTES) {
      const err = new Error(`Publish directory exceeds 100 MB (${total} bytes)`);
      (err as Error & { code: string }).code = "UPLOAD_TOO_LARGE";
      throw err;
    }
  }

  const chunks: Buffer[] = [];
  const stream = tar.c(
    {
      cwd: dir,
      gzip: false,
      portable: true,
    },
    files,
  );

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const size = chunks.reduce((n, c) => n + c.byteLength, 0);
    if (size > MAX_BYTES) {
      const err = new Error("Publish archive exceeds 100 MB");
      (err as Error & { code: string }).code = "UPLOAD_TOO_LARGE";
      throw err;
    }
  }

  return Buffer.concat(chunks);
}

export const PUBLISH_MAX_BYTES = MAX_BYTES;
