// Hostile sample (T2.2, INV6): serves HTTP, then keeps allocating memory it
// never frees. The memory limit (no swap) must OOM-kill this container only.
import http from "node:http";

const hoard = [];
http.createServer((_req, res) => res.end("memory-hog\n")).listen(8080, "0.0.0.0", () => {
  setInterval(() => {
    // Off-heap buffers, touched so the pages are really committed.
    hoard.push(Buffer.alloc(16 * 1024 * 1024, 1));
  }, 20);
});
