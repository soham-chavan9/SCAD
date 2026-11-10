import { newId } from "@scad/shared";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRuntimeProvider } from "./docker-provider.js";
import { createLogDemuxer } from "./logs.js";
import { ensureHttpEchoImage } from "./test-image.js";

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("log demuxer (T1.7)", () => {
  it("emits complete lines from frames split at arbitrary byte boundaries", () => {
    const bytes = Buffer.concat([frame(1, "hello\nwor"), frame(2, "ld\nerr line\n"), frame(1, "partial")]);
    const demux = createLogDemuxer();
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      out.push(...demux.push(bytes.subarray(i, i + 3)));
    }
    expect(out).toEqual(["hello", "world", "err line"]);
    expect(demux.end()).toEqual(["partial"]);
  });

  it("passes plain (non-multiplexed) text through", () => {
    const demux = createLogDemuxer();
    expect(demux.push(Buffer.from("a\nb\n"))).toEqual(["a", "b"]);
  });
});

describe("live runtime logs (T1.7, real Docker)", () => {
  const docker = new Docker();
  const provider = new DockerRuntimeProvider({ gatewayContainerName: null });
  const appId = newId();

  afterAll(async () => {
    await provider.remove(appId, { deleteVolume: true }).catch(() => undefined);
  });

  it("follow streams stdout and stderr lines while the app keeps running", async () => {
    const imageRef = await ensureHttpEchoImage(docker);
    const machine = await provider.deploy({
      appId,
      imageRef,
      port: 8080,
      start: [
        "node",
        "-e",
        "let i=0;setInterval(()=>{i++;console.log('tick '+i);if(i%2===0)console.error('warn '+i)},150);" +
          "require('http').createServer((q,r)=>r.end()).listen(8080)",
      ],
      env: {},
      egressAllow: [],
      limits: { memoryMb: 128, cpuShares: 1024, diskGb: 1, pids: 64 },
    });

    const info = await docker.getContainer(machine.providerId).inspect();
    expect(info.HostConfig.LogConfig).toEqual({
      Type: "json-file",
      Config: { "max-size": "1m", "max-file": "2" },
    });

    const seen: string[] = [];
    const t0 = Date.now();
    const iterator = provider.logs(machine, { follow: true, tail: 0 })[Symbol.asyncIterator]();
    try {
      while (seen.length < 6 && Date.now() - t0 < 10_000) {
        const next = await iterator.next();
        if (next.done) break;
        seen.push(next.value);
      }
    } finally {
      await iterator.return?.();
    }
    // Lines arrived while the container was still running (follow never ends on its own).
    expect(await provider.status(machine)).toBe("running");
    expect(seen.some((l) => l.startsWith("tick "))).toBe(true);
    expect(seen.some((l) => l.startsWith("warn "))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
