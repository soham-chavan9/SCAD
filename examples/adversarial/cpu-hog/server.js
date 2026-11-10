// Hostile sample (T2.8, INV6): serves HTTP, then burns every CPU it can
// (one busy worker per visible core, at most 8 so it stays under its pids
// limit). Its CPU weight must keep neighbours responsive.
import http from "node:http";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

http
  .createServer((_req, res) => res.end("cpu-hog\n"))
  .listen(8080, "0.0.0.0", () => {
    for (let i = 0; i < Math.min(availableParallelism(), 8); i++) {
      new Worker("for (;;) {}", { eval: true }).on("error", () => undefined);
    }
  });
