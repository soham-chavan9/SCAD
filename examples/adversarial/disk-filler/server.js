// Hostile sample (T2.8, INV6): serves HTTP; probe.js tries to fill every
// writable place it can find.
import http from "node:http";

http.createServer((_req, res) => res.end("disk-filler\n")).listen(8080, "0.0.0.0");
