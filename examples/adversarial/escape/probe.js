// Run inside the escape container: `node probe.js`. Tries privileged
// operations an attacker would use to break out; prints one JSON line of
// {attempt: "blocked: <reason>" | "ALLOWED"}.
import { execFileSync } from "node:child_process";
import { chownSync, readFileSync, writeFileSync } from "node:fs";

const out = {};
function attempt(name, fn) {
  try {
    fn();
    out[name] = "ALLOWED";
  } catch (e) {
    out[name] = `blocked: ${e.code ?? e.status ?? e.message?.split("\n")[0] ?? "error"}`;
  }
}
const sh = (cmd) => execFileSync("sh", ["-c", cmd], { stdio: "pipe", timeout: 5000 });

attempt("setuid-root", () => process.setuid(0));
attempt("setgid-root", () => process.setgid(0));
attempt("write-rootfs", () => writeFileSync("/etc/scad-escape", "x"));
attempt("chown-to-root", () => {
  writeFileSync("/tmp/own", "x");
  chownSync("/tmp/own", 0, 0);
});
attempt("mount-tmpfs", () => sh("mkdir -p /tmp/m && mount -t tmpfs none /tmp/m"));
attempt("mknod-device", () => sh("mknod /tmp/kmem c 1 2"));
attempt("chroot", () => sh("chroot / true"));
attempt("user-namespace", () => sh("unshare -U -r true"));
// arping needs a real raw (AF_PACKET) socket, i.e. CAP_NET_RAW. (Plain ping
// works without it via unprivileged ICMP sockets, but only inside the app's
// own network; see icmp-to-internet.)
attempt("raw-socket", () => sh("busybox arping -c 1 -w 1 -I eth0 1.1.1.1"));
attempt("icmp-to-internet", () => sh("ping -c 1 -W 2 1.1.1.1"));
attempt("sysrq-trigger", () => writeFileSync("/proc/sysrq-trigger", "h"));
attempt("kernel-param", () => writeFileSync("/proc/sys/kernel/hostname", "pwned"));
attempt("load-module", () => sh("modprobe dummy || insmod /dev/null"));
attempt("exec-from-tmp", () => {
  writeFileSync("/tmp/x.sh", "#!/bin/sh\necho hi\n", { mode: 0o755 });
  execFileSync("/tmp/x.sh", { stdio: "pipe" });
});

const status = readFileSync("/proc/self/status", "utf8");
const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(status)?.[1]?.trim() ?? "";
console.log(
  JSON.stringify({
    attempts: out,
    uid: process.getuid(),
    capEff: field("CapEff"),
    capPrm: field("CapPrm"),
    noNewPrivs: field("NoNewPrivs"),
    seccomp: field("Seccomp"),
  }),
);
