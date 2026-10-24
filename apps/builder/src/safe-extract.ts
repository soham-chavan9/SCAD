import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import * as tar from "tar";
import { makeError, type ErrorEnvelope } from "@scad/shared";

/** Caps for unpacked publish contexts (aligned with 100 MB upload default). */
export const EXTRACT_LIMITS = {
  maxTotalBytes: 100 * 1024 * 1024,
  maxFiles: 10_000,
  maxFileBytes: 50 * 1024 * 1024,
} as const;

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

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
      "Republish with a clean project tarball (no path escapes, devices, or links outside the root).",
      details,
    ),
  );
}

function shouldSkip(entryPath: string): boolean {
  const parts = entryPath.split(/[/\\]/).filter(Boolean);
  return parts.some((p) => SKIP_DIR_NAMES.has(p));
}

/** Reject absolute paths, Windows drive paths, and any `..` segment. */
export function assertSafeEntryPath(entryPath: string): void {
  if (!entryPath || entryPath === ".") {
    return;
  }
  // Check raw segments before path.normalize collapses `foo/..` to `.`.
  const segments = entryPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    reject("Tarball entry escapes the extract root via ..", { path: entryPath });
  }
  if (entryPath.startsWith("/") || entryPath.startsWith("\\")) {
    reject("Tarball entry has an absolute path", { path: entryPath });
  }
  if (/^[a-zA-Z]:[\\/]/.test(entryPath)) {
    reject("Tarball entry has a Windows absolute path", { path: entryPath });
  }
  const normalized = normalize(entryPath).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    reject("Tarball entry escapes the extract root via ..", { path: entryPath });
  }
  if (normalized.startsWith("/")) {
    reject("Tarball entry normalizes to an absolute path", { path: entryPath });
  }
}

function isInsideRoot(rootReal: string, candidate: string): boolean {
  return candidate.startsWith(rootReal + sep) || candidate === rootReal;
}

type TarHeader = {
  path?: string;
  type?: string;
  size?: number;
  linkpath?: string;
};

function validateEntry(
  entryPath: string,
  type: string,
  size: number,
  linkpath: string,
  rootReal: string,
  limits: typeof EXTRACT_LIMITS,
  counters: { totalBytes: number; fileCount: number },
): void {
  assertSafeEntryPath(entryPath);

  if (
    type === "BlockDevice" ||
    type === "CharacterDevice" ||
    type === "FIFO" ||
    type === "Block" ||
    type === "Character"
  ) {
    reject("Tarball contains a device or FIFO entry", { path: entryPath, type });
  }
  if (type === "Link" || type === "HardLink" || type === "1") {
    reject("Tarball contains a hardlink entry", { path: entryPath, type });
  }

  if (type === "SymbolicLink" || type === "symlink" || type === "2") {
    if (!linkpath) {
      reject("Tarball symlink missing target", { path: entryPath });
    }
    // Absolute or `..` link targets are escapes.
    if (
      linkpath.startsWith("/") ||
      linkpath.startsWith("\\") ||
      /(^|\/)\.\.(\/|$)/.test(normalize(linkpath).replace(/\\/g, "/"))
    ) {
      reject("Tarball symlink target escapes extract root", {
        path: entryPath,
        linkpath,
      });
    }
    const parent = resolve(rootReal, entryPath, "..");
    const target = resolve(parent, linkpath);
    if (!isInsideRoot(rootReal, target)) {
      reject("Tarball symlink target escapes extract root", {
        path: entryPath,
        linkpath,
      });
    }
  }

  if (type === "File" || type === "0" || type === "" || type === "ContiguousFile") {
    if (size > limits.maxFileBytes) {
      reject("Tarball file exceeds per-file size limit", {
        path: entryPath,
        size,
        maxFileBytes: limits.maxFileBytes,
      });
    }
    counters.totalBytes += size;
    counters.fileCount += 1;
    if (counters.fileCount > limits.maxFiles) {
      reject("Tarball exceeds file count limit", {
        maxFiles: limits.maxFiles,
      });
    }
    if (counters.totalBytes > limits.maxTotalBytes) {
      reject("Tarball exceeds total unpacked size limit", {
        maxTotalBytes: limits.maxTotalBytes,
      });
    }
  }
}

/**
 * Extract a publish tarball into a fresh directory.
 * Rejects absolute/`..` paths, devices, FIFOs, hardlinks, and symlinks whose
 * target resolves outside the extract root. Skips `node_modules` and `.git`.
 */
export async function safeExtractTarball(opts: {
  tarballPath: string;
  destDir: string;
  limits?: Partial<typeof EXTRACT_LIMITS>;
}): Promise<void> {
  const limits = { ...EXTRACT_LIMITS, ...opts.limits };
  await mkdir(opts.destDir, { recursive: true });
  const rootReal = await realpath(opts.destDir);

  const counters = { totalBytes: 0, fileCount: 0 };
  let validationError: SafeExtractError | undefined;

  // Validate every entry before writing. Capture errors — throwing inside
  // onReadEntry does not reject tar.t()'s promise.
  await tar.t({
    file: opts.tarballPath,
    onReadEntry(entry) {
      if (validationError) {
        entry.resume();
        return;
      }
      try {
        const header = entry as unknown as TarHeader;
        const entryPath = header.path ?? entry.path;
        if (!entryPath) {
          entry.resume();
          return;
        }
        if (shouldSkip(entryPath)) {
          entry.resume();
          return;
        }
        const type = String(header.type ?? entry.type ?? "");
        const size = Number(header.size ?? entry.size ?? 0);
        const linkpath = header.linkpath ?? "";
        validateEntry(entryPath, type, size, linkpath, rootReal, limits, counters);
      } catch (err) {
        if (err instanceof SafeExtractError) {
          validationError = err;
        } else {
          validationError = new SafeExtractError(
            makeError(
              "VALIDATION_FAILED",
              err instanceof Error ? err.message : "Tarball validation failed",
              "Republish with a clean project tarball.",
              {},
            ),
          );
        }
      }
      entry.resume();
    },
  });

  if (validationError) {
    throw validationError;
  }

  try {
    await tar.x({
      file: opts.tarballPath,
      cwd: opts.destDir,
      filter(p, entry) {
        if (shouldSkip(p)) return false;
        assertSafeEntryPath(p);
        const type =
          entry && typeof entry === "object" && "type" in entry
            ? String((entry as { type?: string }).type ?? "")
            : "";
        if (type === "Link" || type === "HardLink" || type === "1") return false;
        if (
          type === "BlockDevice" ||
          type === "CharacterDevice" ||
          type === "FIFO" ||
          type === "Block" ||
          type === "Character"
        ) {
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    await rm(opts.destDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(opts.destDir, { recursive: true });
    if (err instanceof SafeExtractError) throw err;
    reject(err instanceof Error ? err.message : "Tarball extract failed", {
      cause: String(err),
    });
  }

  await assertNoEscape(rootReal, opts.destDir);
}

async function assertNoEscape(rootReal: string, dir: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      let targetReal: string;
      try {
        targetReal = await realpath(full);
      } catch {
        continue;
      }
      if (!isInsideRoot(rootReal, targetReal)) {
        reject("Extracted symlink resolves outside extract root", { path: full });
      }
    } else if (ent.isDirectory()) {
      await assertNoEscape(rootReal, full);
    } else if (ent.isFile()) {
      const st = await stat(full);
      if (st.isFIFO() || st.isSocket() || st.isBlockDevice() || st.isCharacterDevice()) {
        reject("Extracted special file is not allowed", { path: full });
      }
    }
  }
}
