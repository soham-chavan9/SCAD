import * as tar from "tar";

/** scad.json is small; anything bigger is a mistake or an attack. */
export const MAX_SCAD_JSON_BYTES = 64 * 1024;

export class ScadJsonTooLargeError extends Error {
  constructor() {
    super(`scad.json is larger than ${MAX_SCAD_JSON_BYTES} bytes`);
    this.name = "ScadJsonTooLargeError";
  }
}

function isRootScadJson(path: string): boolean {
  return path.replace(/^(\.\/)+/, "") === "scad.json";
}

/**
 * Read the text of `scad.json` at the root of a publish tarball (gzip or
 * plain tar). Returns null when there is none. Nothing is written to disk;
 * entries other than the root regular file `scad.json` are skipped unread.
 */
export async function readRootScadJson(tarball: Buffer): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let text: string | null = null;
    let failure: Error | null = null;

    const parser = new tar.Parser({
      onReadEntry: (entry) => {
        if (entry.type !== "File" || !isRootScadJson(entry.path) || failure) {
          entry.resume();
          return;
        }
        if (entry.size > MAX_SCAD_JSON_BYTES) {
          failure = new ScadJsonTooLargeError();
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          text = Buffer.concat(chunks).toString("utf8");
        });
      },
    });
    parser.on("error", (err: Error) => reject(err));
    parser.on("end", () => (failure ? reject(failure) : resolve(text)));
    parser.end(tarball);
  });
}
