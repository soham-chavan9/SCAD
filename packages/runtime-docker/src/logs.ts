import type { Readable } from "node:stream";

/** Decode Docker's multiplexed log stream into text lines. */
export async function* linesFromDockerLogs(
  data: Buffer | Readable,
): AsyncIterable<string> {
  const text = Buffer.isBuffer(data)
    ? demuxToString(data)
    : await streamToDemuxedString(data);

  const parts = text.split(/\r?\n/);
  for (const part of parts) {
    if (part.length > 0) {
      yield part;
    }
  }
}

function demuxToString(buf: Buffer): string {
  // Docker multiplexed frames: 8-byte header + payload.
  // If the buffer doesn't look multiplexed, treat as plain UTF-8.
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      offset += 8;
      if (offset + size > buf.length) {
        break;
      }
      chunks.push(buf.subarray(offset, offset + size));
      offset += size;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return buf.toString("utf8");
}

async function streamToDemuxedString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return demuxToString(Buffer.concat(chunks));
}
