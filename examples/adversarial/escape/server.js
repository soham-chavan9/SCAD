// Hostile sample (T2.8, INV6): probes for privileged syscalls on demand
// (see probe.js). Serves HTTP so it deploys like any app.
import http from "node:http";

http.createServer((_req, res) => res.end("escape\n")).listen(8080, "0.0.0.0");
