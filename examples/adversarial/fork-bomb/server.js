// Hostile sample (T2.2, INV6): serves HTTP, then starts a classic shell fork
// bomb. The pids limit must stop it inside this container; neighbours and the
// host must not notice.
import http from "node:http";
import { spawn } from "node:child_process";

http.createServer((_req, res) => res.end("fork-bomb\n")).listen(8080, "0.0.0.0", () => {
  const bomb = spawn("sh", ["-c", ":(){ :|:& };:"], { stdio: "ignore" });
  bomb.on("error", () => undefined);
});
