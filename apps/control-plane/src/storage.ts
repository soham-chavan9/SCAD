import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type DataPaths = {
  root: string;
  tarballPath: (releaseId: string) => string;
  logPath: (releaseId: string) => string;
};

/**
 * Paths under the data dir. Always absolute: the builder runs in another
 * working directory and opens tarballs by the path the claim hands it.
 */
export function createDataPaths(dir: string): DataPaths {
  const root = resolve(dir);
  return {
    root,
    tarballPath: (releaseId) => join(root, "tarballs", `${releaseId}.tar`),
    logPath: (releaseId) => join(root, "logs", `${releaseId}.log`),
  };
}

export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  await mkdir(join(paths.root, "tarballs"), { recursive: true });
  await mkdir(join(paths.root, "logs"), { recursive: true });
}

export async function saveTarball(
  paths: DataPaths,
  releaseId: string,
  data: Buffer,
): Promise<string> {
  await ensureDataDirs(paths);
  const file = paths.tarballPath(releaseId);
  await writeFile(file, data);
  return file;
}

export async function readTarball(paths: DataPaths, releaseId: string): Promise<Buffer> {
  return readFile(paths.tarballPath(releaseId));
}

export async function appendBuildLog(
  paths: DataPaths,
  releaseId: string,
  chunk: string,
): Promise<void> {
  await ensureDataDirs(paths);
  await appendFile(paths.logPath(releaseId), chunk.endsWith("\n") ? chunk : `${chunk}\n`);
}

export async function readBuildLogTail(
  paths: DataPaths,
  releaseId: string,
  maxLines = 50,
): Promise<string[]> {
  try {
    const text = await readFile(paths.logPath(releaseId), "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
