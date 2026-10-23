import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import * as tar from "tar";
import { makeError, type ErrorEnvelope } from "@scad/shared";

/** Caps for unpacked publish trees (aligned with AGENTS §14 100 MB upload). */
export const EXTRACT_LIMITS = {
  maxTotalBytes: 100 * 1024 * 1024,
  maxFiles: 10_000,
  maxFileBytes: 50 * 1024 * 1024,
} as const;

const SKIP_PREFIXES = ["node_modules/", ".git/"] as const;

export class SafeExtractError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "SafeExtractError";
    this.envelope = envelope;
  }
}

function reject(message: string, details: Record<string, unknown> = {}): never {
  throw new SafeExtractError(
    makeError(
      "VALIDATION_FAILED",
      message,
      "Republish with a clean tree: no absolute paths, .., symlinks/hardlinks outside the root, or special files.",
      details,
    ),
  );
}

function shouldSkip(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return SKIP_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p));
}

/** Normalize entry path; reject absolute and `..` segments. */
export function sanitizeEntryPath(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned || cleaned === ".") {
    reject("Empty or `.` entry path in tarball", { path: raw });
  }
  if (isAbsolute(cleaned) || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    reject("Absolute path in tarball", { path: raw });
  }
  const parts = cleaned.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    reject("Path traversal (`..` or empty segment) in tarball", { path: raw });
  }
  return parts.join("/");
}

function assertInsideRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root) + sep;
  const resolved = resolve(candidate);
  if (resolved !== resolve(root) && !resolved.startsWith(resolvedRoot)) {
    reject("Path escapes extract root", { path: candidate, root });
  }
}

function assertSymlinkTargetInsideRoot(root: string, linkPath: string, target: string): void {
  if (!target || target.includes("\0") || isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
    reject("Symlink target must be relative and inside extract root", {
      path: linkPath,
      target,
    });
  }
  // Reject any `..` segment in the stored target (even if it would normalize inside).
  if (target.split(/[/\\]/).includes("..")) {
    reject("Symlink target must not contain `..`", { path: linkPath, target });
  }
  const linkDir = join(root, ...linkPath.split("/").slice(0, -1));
  const resolved = resolve(linkDir, normalize(target));
  assertInsideRoot(root, resolved);
}

type EntryMeta = {
  path: string;
  type: string;
  size: number;
  linkpath?: string;
};

function validateEntry(root: string, entry: EntryMeta, counters: { files: number; bytes: number }, limits: typeof EXTRACT_LIMITS): void {
  const rel = sanitizeEntryPath(entry.path);
  if (shouldSkip(rel)) return;

  const type = entry.type;
  if (
    type === "BlockDevice" ||
    type === "CharacterDevice" ||
    type === "FIFO" ||
    type === "Socket"
  ) {
    reject("Device, FIFO, or socket entries are not allowed", { path: rel, type });
  }
  if (type === "Link") {
    reject("Hardlinks are not allowed in publish tarballs", { path: rel });
  }
  if (type === "SymbolicLink") {
    assertSymlinkTargetInsideRoot(root, rel, entry.linkpath ?? "");
  }

  if (type === "File" || type === "OldFile" || type === "ContiguousFile") {
    counters.files += 1;
    if (counters.files > limits.maxFiles) {
      reject("Too many files in tarball", { maxFiles: limits.maxFiles });
    }
    const size = entry.size;
    if (size > limits.maxFileBytes) {
      reject("File exceeds per-file size limit", {
        path: rel,
        size,
        maxFileBytes: limits.maxFileBytes,
      });
    }
    counters.bytes += size;
    if (counters.bytes > limits.maxTotalBytes) {
      reject("Unpacked size exceeds limit", {
        totalBytes: counters.bytes,
        maxTotalBytes: limits.maxTotalBytes,
      });
    }
  }
}

/**
 * Extract a publish tarball into a **fresh** temp directory under `os.tmpdir()`.
 * Two-pass: validate every entry first, then extract — nothing is written on reject.
 */
export async function extractPublishTarball(
  tarballPath: string,
  limits: typeof EXTRACT_LIMITS = EXTRACT_LIMITS,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scad-build-"));
  const counters = { files: 0, bytes: 0 };

  try {
    // Pass 1: list + validate (no writes). Do not throw inside onReadEntry —
    // tar emits that as an uncaught exception; capture and rethrow after.
    let validationError: SafeExtractError | undefined;
    await tar.t({
      file: tarballPath,
      onReadEntry(entry) {
        if (validationError) {
          entry.resume();
          return;
        }
        try {
          validateEntry(
            root,
            {
              path: entry.path,
              type: entry.type,
              size: Number(entry.size ?? 0),
              ...(entry.linkpath !== undefined ? { linkpath: entry.linkpath } : {}),
            },
            counters,
            limits,
          );
        } catch (err) {
          validationError =
            err instanceof SafeExtractError
              ? err
              : new SafeExtractError(
                  makeError(
                    "VALIDATION_FAILED",
                    err instanceof Error ? err.message : "Tarball validation failed",
                    "Republish with a clean tree: no absolute paths, .., symlinks/hardlinks outside the root, or special files.",
                    {},
                  ),
                );
        }
        entry.resume();
      },
    });
    if (validationError) throw validationError;

    // Pass 2: extract into the fresh root only.
    await tar.x({
      file: tarballPath,
      cwd: root,
      preservePaths: false,
      strict: true,
      filter(path, entry) {
        const rel = sanitizeEntryPath(path);
        if (shouldSkip(rel)) return false;
        if ("path" in entry) {
          (entry as { path: string }).path = rel;
        }
        return true;
      },
    });

    return root;
  } catch (err) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof SafeExtractError) throw err;
    throw new SafeExtractError(
      makeError(
        "VALIDATION_FAILED",
        err instanceof Error ? err.message : "Tarball extract failed",
        "Republish with a valid ustar/posix tar of regular files and directories only.",
        {},
      ),
    );
  }
}

/** Test helper. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
