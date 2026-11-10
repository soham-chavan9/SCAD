// Hostile sample (T2.8; INV1, INV7, INV8): a normal-looking app that, when
// probed, hunts for another app's data and secrets and for the Docker socket.
import http from "node:http";

http.createServer((_req, res) => res.end("snoop\n")).listen(8080, "0.0.0.0");
