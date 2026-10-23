import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BuildResult = {
  ok: true;
  imageRef: string;
  log: string;
} | {
  ok: false;
  log: string;
  message: string;
};

export async function dockerBuild(opts: {
  contextDir: string;
  imageRef: string;
}): Promise<BuildResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["build", "-t", opts.imageRef, opts.contextDir],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    return { ok: true, imageRef: opts.imageRef, log: `${stdout}\n${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const log = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? String(err)}`;
    return {
      ok: false,
      log,
      message: "docker build failed",
    };
  }
}
