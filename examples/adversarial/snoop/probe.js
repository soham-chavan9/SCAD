// Run inside the snoop container: `node probe.js <marker> <neighbour-ip>`.
// Prints one JSON line. Every field must come back "not found" / false.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const [marker = "", neighbour = ""] = process.argv.slice(2);
const hits = [];

function scanFile(path) {
  try {
    if (readFileSync(path).includes(marker)) hits.push(path);
  } catch {
    // unreadable: fine
  }
}

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, depth + 1);
    else if (s.isFile() && s.size < 5_000_000) scanFile(p);
  }
}

// Every process we can see: their env and command line. Skip this probe
// itself: its own command line carries the marker it is looking for.
for (const pid of readdirSync("/proc").filter(
  (n) => /^\d+$/.test(n) && Number(n) !== process.pid,
)) {
  scanFile(`/proc/${pid}/environ`);
  scanFile(`/proc/${pid}/cmdline`);
}
// Our own filesystem, including /data and /tmp.
for (const dir of ["/data", "/tmp", "/home", "/var", "/mnt", "/run", "/srv", "/opt"]) walk(dir);

const sockets = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/run/containerd/containerd.sock",
].filter((p) => existsSync(p));
const processes = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).length;

function tcp(host, port) {
  return new Promise((resolve) => {
    if (!host) return resolve("skipped");
    const s = net.connect(port, host, () => {
      s.destroy();
      resolve("open");
    });
    s.setTimeout(2000, () => {
      s.destroy();
      resolve("timeout");
    });
    s.on("error", (e) => resolve(e.code ?? "error"));
  });
}

console.log(
  JSON.stringify({
    secretHits: hits,
    dockerSockets: sockets,
    processes,
    neighbourTcp: await tcp(neighbour, 8080),
  }),
);
