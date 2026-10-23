import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { createPublishTarball, PACKAGE_NAME, PUBLISH_MAX_BYTES } from "./index.js";

describe("@scad/cli", () => {
  it("exports helpers", () => {
    expect(PACKAGE_NAME).toBe("cli");
    expect(PUBLISH_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it("createPublishTarball respects .gitignore and .scadignore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-tar-"));
    await writeFile(join(dir, "keep.js"), "ok");
    await writeFile(join(dir, ".gitignore"), "skip-git.txt\n");
    await writeFile(join(dir, ".scadignore"), "skip-scad.txt\n");
    await writeFile(join(dir, "skip-git.txt"), "no");
    await writeFile(join(dir, "skip-scad.txt"), "no");
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "x.js"), "no");

    const tarBuf = await createPublishTarball(dir);
    const entries: string[] = [];
    const tmpTar = join(dir, "out.tar");
    await writeFile(tmpTar, tarBuf);
    await tar.t({
      file: tmpTar,
      onentry: (e) => {
        entries.push(e.path.replace(/\/$/, ""));
      },
    });

    expect(entries).toContain("keep.js");
    expect(entries).not.toContain("skip-git.txt");
    expect(entries).not.toContain("skip-scad.txt");
    expect(entries.some((e) => e.startsWith("node_modules"))).toBe(false);
    expect(entries).not.toContain(".gitignore");
    expect(entries).not.toContain(".scadignore");
  });
});
