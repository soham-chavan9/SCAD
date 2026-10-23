import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Docker from "dockerode";

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/http-echo",
);

const IMAGE_REPO = "scad-test/http-echo";

/** Build (or reuse) the non-root http-echo image used by conformance tests. */
export async function ensureHttpEchoImage(docker = new Docker()): Promise<string> {
  const tag = await fixtureContentTag(FIXTURE_DIR);
  const imageRef = `${IMAGE_REPO}:${tag}`;

  try {
    await docker.getImage(imageRef).inspect();
    return imageRef;
  } catch {
    // build below
  }

  await execFileAsync("docker", ["build", "-t", imageRef, FIXTURE_DIR], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return imageRef;
}

async function fixtureContentTag(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = (await readdir(dir)).sort();
  for (const name of entries) {
    hash.update(name);
    const file = createReadStream(path.join(dir, name));
    for await (const chunk of file) {
      hash.update(chunk);
    }
  }
  return hash.digest("hex").slice(0, 12);
}
