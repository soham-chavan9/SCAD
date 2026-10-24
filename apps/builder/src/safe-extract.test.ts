import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { SafeExtractError, safeExtractTarball } from "./safe-extract.js";

const temps: string[] = [];

afterEach(async () => {
  for (const d of temps.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function freshDirs(): Promise<{ root: string; dest: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "scad-tar-"));
  temps.push(root);
  const dest = join(root, "dest");
  const outside = join(root, "outside");
  await mkdir(dest);
  await mkdir(outside);
  return { root, dest, outside };
}

/** Pack entries via tar.c into a .tar.gz file. */
async function packTar(
  cwd: string,
  outFile: string,
  entries: string[],
): Promise<void> {
  await tar.c({ gzip: true, file: outFile, cwd }, entries);
}

describe("safeExtractTarball", () => {
  it("extracts a normal tarball into dest", async () => {
    const { dest, root } = await freshDirs();
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "hello.txt"), "hi");
    const tarball = join(root, "ok.tgz");
    await packTar(src, tarball, ["hello.txt"]);

    await safeExtractTarball({ tarballPath: tarball, destDir: dest });
    expect(await readFile(join(dest, "hello.txt"), "utf8")).toBe("hi");
  });

  it("rejects absolute path entries with structured error; nothing outside root", async () => {
    const { dest, outside, root } = await freshDirs();
    const marker = join(outside, "pwned");
    const tarball = join(root, "abs.tgz");

    // Craft a tar with an absolute path via low-level Pack headers is awkward;
    // use tar header path override by writing a minimal ustar manually.
    await writeMaliciousTar(tarball, [{ name: "/tmp/scad-abs-pwn", content: "x", type: "file" }]);

    await expect(safeExtractTarball({ tarballPath: tarball, destDir: dest })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(SafeExtractError);
        const e = err as SafeExtractError;
        expect(e.envelope.code).toBe("VALIDATION_FAILED");
        expect(e.envelope.message).toMatch(/absolute/i);
        return true;
      },
    );
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("rejects a .. segment even when path.normalize collapses it", async () => {
    const { dest, outside, root } = await freshDirs();
    const tarball = join(root, "collapse.tgz");
    await writeMaliciousTar(tarball, [{ name: "foo/..", content: "dir-escape", type: "file" }]);

    await expect(safeExtractTarball({ tarballPath: tarball, destDir: dest })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(SafeExtractError);
        expect((err as SafeExtractError).envelope.code).toBe("VALIDATION_FAILED");
        return true;
      },
    );
    await expect(readFile(join(outside, "dir-escape"))).rejects.toThrow();
    await expect(readFile(join(root, "dir-escape"))).rejects.toThrow();
  });

  it("rejects .. path traversal with structured error", async () => {
    const { dest, outside, root } = await freshDirs();
    const tarball = join(root, "dotdot.tgz");
    await writeMaliciousTar(tarball, [
      { name: "../outside/pwned-dotdot", content: "nope", type: "file" },
    ]);

    await expect(safeExtractTarball({ tarballPath: tarball, destDir: dest })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(SafeExtractError);
        expect((err as SafeExtractError).envelope.code).toBe("VALIDATION_FAILED");
        expect((err as SafeExtractError).envelope.message).toMatch(/\.\./);
        return true;
      },
    );
    await expect(readFile(join(outside, "pwned-dotdot"))).rejects.toThrow();
  });

  it("rejects symlink whose target is outside the extract root", async () => {
    const { dest, outside, root } = await freshDirs();
    await writeFile(join(outside, "secret"), "secret");
    const tarball = join(root, "symlink.tgz");
    await writeMaliciousTar(tarball, [
      { name: "leak", type: "symlink", linkpath: "../outside/secret" },
    ]);

    await expect(safeExtractTarball({ tarballPath: tarball, destDir: dest })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(SafeExtractError);
        expect((err as SafeExtractError).envelope.code).toBe("VALIDATION_FAILED");
        expect((err as SafeExtractError).envelope.message).toMatch(/symlink/i);
        return true;
      },
    );
  });

  it("rejects hardlink entries", async () => {
    const { dest, root } = await freshDirs();
    const tarball = join(root, "hardlink.tgz");
    await writeMaliciousTar(tarball, [
      { name: "a.txt", content: "a", type: "file" },
      { name: "b.txt", type: "hardlink", linkpath: "a.txt" },
    ]);

    await expect(safeExtractTarball({ tarballPath: tarball, destDir: dest })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(SafeExtractError);
        expect((err as SafeExtractError).envelope.message).toMatch(/hardlink/i);
        return true;
      },
    );
  });

  it("rejects FIFO / device entries", async () => {
    const { dest, root } = await freshDirs();
    const tarball = join(root, "fifo.tgz");
    await writeMaliciousTar(tarball, [{ name: "pipe", type: "fifo" }]);

    await expect(safeExtractTarball({ tarballPath: tarball, destDir: dest })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(SafeExtractError);
        expect((err as SafeExtractError).envelope.message).toMatch(/device|FIFO/i);
        return true;
      },
    );
  });

  it("rejects over per-file size limit", async () => {
    const { dest, root } = await freshDirs();
    const src = join(root, "src");
    await mkdir(src);
    await writeFile(join(src, "big.bin"), Buffer.alloc(100));
    const tarball = join(root, "big.tgz");
    await packTar(src, tarball, ["big.bin"]);

    await expect(
      safeExtractTarball({
        tarballPath: tarball,
        destDir: dest,
        limits: { maxFileBytes: 50 },
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SafeExtractError);
      expect((err as SafeExtractError).envelope.message).toMatch(/per-file/i);
      return true;
    });
  });

  it("skips node_modules and .git entries", async () => {
    const { dest, root } = await freshDirs();
    const src = join(root, "src");
    await mkdir(join(src, "node_modules", "x"), { recursive: true });
    await mkdir(join(src, ".git"), { recursive: true });
    await writeFile(join(src, "node_modules", "x", "evil.js"), "evil");
    await writeFile(join(src, ".git", "config"), "nope");
    await writeFile(join(src, "ok.js"), "ok");
    const tarball = join(root, "skip.tgz");
    await packTar(src, tarball, ["node_modules", ".git", "ok.js"]);

    await safeExtractTarball({ tarballPath: tarball, destDir: dest });
    expect(await readFile(join(dest, "ok.js"), "utf8")).toBe("ok");
    await expect(readFile(join(dest, "node_modules", "x", "evil.js"))).rejects.toThrow();
    await expect(readFile(join(dest, ".git", "config"))).rejects.toThrow();
  });
});

type MaliciousEntry =
  | { name: string; type: "file"; content: string }
  | { name: string; type: "symlink"; linkpath: string }
  | { name: string; type: "hardlink"; linkpath: string }
  | { name: string; type: "fifo" };

/**
 * Write a gzipped ustar archive with attacker-controlled header paths.
 * Used only for malicious-tar rejection tests.
 */
async function writeMaliciousTar(outFile: string, entries: MaliciousEntry[]): Promise<void> {
  const blocks: Buffer[] = [];
  for (const ent of entries) {
    const typeflag =
      ent.type === "file" ? "0" : ent.type === "hardlink" ? "1" : ent.type === "symlink" ? "2" : "6";
    const content = ent.type === "file" ? Buffer.from(ent.content) : Buffer.alloc(0);
    const linkpath = "linkpath" in ent ? ent.linkpath : "";
    blocks.push(ustarHeader(ent.name, typeflag, content.length, linkpath));
    if (content.length > 0) {
      const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
      content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks = EOF
  const raw = Buffer.concat(blocks);
  const gzip = createGzip();
  const src = Readable.from(raw);
  await pipeline(src, gzip, createWriteStream(outFile));
}

function ustarHeader(name: string, typeflag: string, size: number, linkpath: string): Buffer {
  const buf = Buffer.alloc(512);
  const put = (str: string, offset: number, len: number) => {
    buf.write(str.slice(0, len), offset, "utf8");
  };
  put(name, 0, 100);
  put("0000644\0", 100, 8); // mode
  put("0000000\0", 108, 8); // uid
  put("0000000\0", 116, 8); // gid
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
  put("        ", 148, 8); // checksum placeholder
  put(typeflag, 156, 1);
  put(linkpath, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i]!;
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  buf.write(checksum, 148, "utf8");
  return buf;
}
