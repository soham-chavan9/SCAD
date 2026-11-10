// Run inside the disk-filler container: `node probe.js <data-mib>`.
// Writes 1 MiB chunks until each target refuses; prints MiB written and why.
import { closeSync, openSync, writeSync } from "node:fs";

const dataMib = Number(process.argv[2] ?? "8");
const chunk = Buffer.alloc(1024 * 1024, 120);
function fill(path, maxMib) {
  let fd;
  let mib = 0;
  try {
    fd = openSync(path, "w");
    while (mib < maxMib) {
      writeSync(fd, chunk);
      mib++;
    }
    return { mib, stopped: "max" };
  } catch (e) {
    return { mib, stopped: e.code ?? "error" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
console.log(
  JSON.stringify({
    rootfs: fill("/home/node/app/fill.bin", 4),
    tmp: fill("/tmp/fill.bin", 512),
    data: fill("/data/fill.bin", dataMib),
  }),
);
