import { createWriteStream, linkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRACT_LIMITS,
  extractPublishTarball,
  SafeExtractError,
  sanitizeEntryPath,
} from "./safe-extract.js";

const leftovers: string[] = [];

afterEach(async () => {
  for (const p of leftovers.splice(0)) {
    await rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function pack(
  dir: string,
  files: string[],
  onWriteEntry?: (entry: { path: string; type?: string }) => void,
): Promise<string> {
  const out = join(dir, `pack-${files.length}-${Date.now()}.tar`);
  await pipeline(
    tar.c(
      {
        cwd: dir,
        gzip: false,
        portable: true,
        ...(onWriteEntry
          ? {
              onWriteEntry(entry: { path: string; type?: string }) {
                onWriteEntry(entry);
              },
            }
          : {}),
      },
      files,
    ),
    createWriteStream(out),
  );
  return out;
}

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scad-tar-fix-"));
  leftovers.push(dir);
  await writeFile(join(dir, "ok.txt"), "hello\n");
  return dir;
}

describe("sanitizeEntryPath", () => {
  it("accepts relative safe paths", () => {
    expect(sanitizeEntryPath("./src/app.js")).toBe("src/app.js");
  });

  it("rejects absolute and ..", () => {
    expect(() => sanitizeEntryPath("/etc/passwd")).toThrow(SafeExtractError);
    expect(() => sanitizeEntryPath("../escape")).toThrow(SafeExtractError);
  });
});

describe("extractPublishTarball", () => {
  it("extracts a clean tarball into a fresh temp dir", async () => {
    const dir = await fixtureDir();
    const tarPath = await pack(dir, ["ok.txt"]);
    const root = await extractPublishTarball(tarPath);
    leftovers.push(root);
    expect(await readFile(join(root, "ok.txt"), "utf8")).toBe("hello\n");
    expect(root.includes("scad-build-")).toBe(true);
  });

  it("rejects absolute path with structured error; nothing written at absolute path", async () => {
    const dir = await fixtureDir();
    const marker = join(tmpdir(), `scad-abs-escape-${process.pid}-${Date.now()}`);
    leftovers.push(marker);
    const tarPath = await pack(dir, ["ok.txt"], (entry) => {
      entry.path = marker;
    });
    await expect(extractPublishTarball(tarPath)).rejects.toMatchObject({
      name: "SafeExtractError",
      envelope: { code: "VALIDATION_FAILED" },
    });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("rejects .. traversal with structured error", async () => {
    const dir = await fixtureDir();
    const tarPath = await pack(dir, ["ok.txt"], (entry) => {
      entry.path = "../../tmp/scad-dotdot-escape";
    });
    await expect(extractPublishTarball(tarPath)).rejects.toMatchObject({
      envelope: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects symlink target outside root", async () => {
    const dir = await fixtureDir();
    await symlink("/etc/passwd", join(dir, "link"));
    const tarPath = await pack(dir, ["ok.txt", "link"]);
    await expect(extractPublishTarball(tarPath)).rejects.toMatchObject({
      envelope: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects hardlink entries", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "a.txt"), "a");
    linkSync(join(dir, "a.txt"), join(dir, "b.txt"));
    const tarPath = await pack(dir, ["a.txt", "b.txt"]);
    await expect(extractPublishTarball(tarPath)).rejects.toMatchObject({
      envelope: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects FIFO entries", async () => {
    const dir = await fixtureDir();
    const tarPath = await pack(dir, ["ok.txt"], (entry) => {
      entry.type = "FIFO";
    });
    await expect(extractPublishTarball(tarPath)).rejects.toMatchObject({
      envelope: { code: "VALIDATION_FAILED" },
    });
  });

  it("rejects device-type entries", async () => {
    const dir = await fixtureDir();
    const tarPath = await pack(dir, ["ok.txt"], (entry) => {
      entry.type = "CharacterDevice";
    });
    await expect(extractPublishTarball(tarPath)).rejects.toMatchObject({
      envelope: { code: "VALIDATION_FAILED" },
    });
  });

  it("skips node_modules and .git", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "evil.js"), "steal");
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "nope");
    await writeFile(join(dir, "app.js"), "ok");
    const tarPath = await pack(dir, [
      "ok.txt",
      "app.js",
      "node_modules/x/evil.js",
      ".git/config",
    ]);
    const root = await extractPublishTarball(tarPath);
    leftovers.push(root);
    expect(await readFile(join(root, "app.js"), "utf8")).toBe("ok");
    await expect(readFile(join(root, "node_modules", "x", "evil.js"))).rejects.toThrow();
    await expect(readFile(join(root, ".git", "config"))).rejects.toThrow();
  });

  it("rejects over per-file size limit", async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, "big.bin"), Buffer.alloc(1024, 1));
    const tarPath = await pack(dir, ["big.bin"]);
    await expect(
      extractPublishTarball(tarPath, { ...EXTRACT_LIMITS, maxFileBytes: 100 }),
    ).rejects.toMatchObject({
      envelope: { code: "VALIDATION_FAILED" },
    });
  });
});
