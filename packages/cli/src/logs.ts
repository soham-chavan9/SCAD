import { client, type ClientOptions } from "./share.js";

/** `scad logs <app> [-f]`: print runtime log lines as they arrive (owner only). */
export async function streamLogs(
  opts: ClientOptions & {
    app: string;
    follow: boolean;
    tail?: number;
    signal?: AbortSignal;
    onLine: (line: string) => void;
  },
): Promise<void> {
  await (await client(opts)).streamLogs(
    opts.app,
    {
      follow: opts.follow,
      ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    opts.onLine,
  );
}
