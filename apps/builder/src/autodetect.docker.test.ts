import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareBuildContext } from "./autodetect.js";
import { dockerBuild } from "./docker-build.js";

const execFileAsync = promisify(execFile);

/**
 * T2.4: the Python template installs vendored wheels with `--network=none`.
 * Fetching the wheel needs the internet (outside the build); skipped offline.
 */
describe("python template with vendored wheels (real Docker, offline build)", () => {
  it("installs a wheel from wheels/ and the app can import it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scad-wheels-"));
    try {
      await mkdir(join(dir, "wheels"));
      try {
        await execFileAsync("docker", [
          "run", "--rm", "-v", `${join(dir, "wheels")}:/w`, "python:3.12-alpine",
          "pip", "download", "-q", "--disable-pip-version-check", "six==1.17.0", "-d", "/w",
        ]);
      } catch {
        console.warn("skipping: could not download a wheel (offline?)");
        return;
      }
      await writeFile(join(dir, "requirements.txt"), "six==1.17.0\n");
      await writeFile(join(dir, "app.py"), 'import six\nprint("six", six.__version__, flush=True)\n');
      expect(await prepareBuildContext(dir, 8080)).toEqual({ kind: "python" });
      const build = await dockerBuild({ contextDir: dir, imageRef: "scad-test/py-wheels:1" });
      expect(build.ok, build.log.slice(-2000)).toBe(true);
      const { stdout } = await execFileAsync("docker", [
        "run", "--rm", "--read-only", "--network=none", "scad-test/py-wheels:1",
      ]);
      expect(stdout).toContain("six 1.17.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
