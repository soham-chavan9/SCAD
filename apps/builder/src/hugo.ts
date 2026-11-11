import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";

/**
 * T3.2: Hugo sites build with a pinned Hugo release. The builder (trusted
 * code, not the app) downloads it once from GitHub, checks the SHA-256 below,
 * and caches it. The app's offline build only ever sees the verified binary.
 * The standard (not extended) edition is a static binary, so it runs on the
 * Alpine build image on arm64 and amd64.
 */
export const HUGO_VERSION = "0.169.0";

/** From hugo_0.169.0_checksums.txt on the GitHub release. */
export const HUGO_SHA256: Record<"arm64" | "amd64", string> = {
  arm64: "ddadaaccbf437e3d39c33140b80c2180c4f46d027d16b7716c1282ea2e14e00c",
  amd64: "2d2f0bfe357d8cb4cec02f6bb28a3bff34978c8dda44b618029c5eb9d66765a7",
};

export function hugoUrl(arch: "arm64" | "amd64"): string {
  return `https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_linux-${arch}.tar.gz`;
}

export function normaliseArch(dockerArch: string): "arm64" | "amd64" {
  const a = dockerArch.trim();
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "amd64" || a === "x86_64") return "amd64";
  throw new Error(`unsupported Docker architecture ${a}`);
}

function cacheRoot(): string {
  return join(process.env["SCAD_DATA_DIR"] ?? join(homedir(), ".scad"), "cache");
}

/** Path to a verified Hugo binary for `arch`, downloading it on first use. */
export async function ensureHugo(
  arch: "arm64" | "amd64",
  opts: { fetchImpl?: typeof fetch; cacheDir?: string } = {},
): Promise<string> {
  const dir = join(opts.cacheDir ?? cacheRoot(), `hugo-${HUGO_VERSION}-linux-${arch}`);
  const bin = join(dir, "hugo");
  try {
    if ((await stat(bin)).isFile()) return bin;
  } catch {
    // not cached yet
  }
  const res = await (opts.fetchImpl ?? fetch)(hugoUrl(arch), { redirect: "follow" });
  if (!res.ok) throw new Error(`downloading Hugo ${HUGO_VERSION} failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== HUGO_SHA256[arch]) {
    throw new Error(`Hugo ${HUGO_VERSION} (${arch}) checksum mismatch: got ${digest}`);
  }
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(join(dir, ".dl-"));
  try {
    const archive = join(tmp, "hugo.tar.gz");
    await writeFile(archive, body);
    await tar.x({ file: archive, cwd: tmp, filter: (p) => p === "hugo" });
    const extracted = join(tmp, "hugo");
    if (!(await readFile(extracted)).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error("Hugo archive did not contain a Linux binary");
    }
    await chmod(extracted, 0o755);
    await rename(extracted, bin);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return bin;
}
