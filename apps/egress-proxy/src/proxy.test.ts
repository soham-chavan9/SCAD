import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  describeOperatorPolicy,
  hostAllowed,
  isBlockedAddress,
  parseOperatorAllow,
  PolicyIndex,
} from "./proxy.js";

describe("blocked address ranges (INV2, after DNS resolution)", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.17.0.1",
    "192.168.65.254",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "140.82.112.3", "2606:4700::6810:85e5"])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("blocks anything that is not an IP literal", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("domain policy", () => {
  it("needs both the app's manifest and the operator to allow a host", () => {
    expect(hostAllowed("api.github.com", ["api.github.com"], ["*"])).toBe(true);
    expect(hostAllowed("api.github.com", ["api.github.com"], [])).toBe(false);
    expect(hostAllowed("api.github.com", [], ["*"])).toBe(false);
    expect(hostAllowed("api.github.com", ["api.github.com"], ["*.github.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["api.github.com"], ["*"])).toBe(false);
  });

  it("wildcards match subdomains only, case-insensitively", () => {
    expect(hostAllowed("x.googleapis.com", ["*.googleapis.com"], ["*"])).toBe(true);
    expect(hostAllowed("X.GoogleApis.com.", ["*.googleapis.com"], ["*"])).toBe(true);
    expect(hostAllowed("googleapis.com", ["*.googleapis.com"], ["*"])).toBe(false);
    expect(hostAllowed("evilgoogleapis.com", ["*.googleapis.com"], ["*"])).toBe(false);
  });

  it("finds the app by source IP subnet", () => {
    const index = new PolicyIndex([
      { appId: "a", subnet: "172.30.1.0/24", allow: ["a.com"] },
      { appId: "b", subnet: "172.30.2.0/24", allow: ["b.com"] },
    ]);
    expect(index.appFor("172.30.2.7")?.appId).toBe("b");
    expect(index.appFor("::ffff:172.30.1.9")?.appId).toBe("a");
    expect(index.appFor("172.30.3.1")).toBeUndefined();
  });
});

describe("egress proxy (T2.1)", () => {
  let policyDir: string;
  let proxy: http.Server;
  let proxyPort: number;
  let upstream: net.Server;
  let upstreamHttp: http.Server;
  const dials: string[] = [];
  /** Fake DNS: the "public" names resolve to a public IP; rebind.example resolves to a private one. */
  const dns: Record<string, string[]> = {
    "allowed.example": ["93.184.216.34"],
    "other.example": ["93.184.216.35"],
    "rebind.example": ["93.184.216.36", "10.0.0.5"],
  };

  beforeAll(async () => {
    policyDir = await mkdtemp(join(tmpdir(), "scad-egress-"));
    await writeFile(
      join(policyDir, "app-1.json"),
      JSON.stringify({ appId: "app-1", subnet: "127.0.0.1/32", allow: ["allowed.example", "rebind.example"] }),
    );
    // Stand-ins for the internet: a TCP echo (for CONNECT) and an HTTP server.
    upstream = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamHttp = http.createServer((req, res) => res.end(`upstream saw ${req.headers.host} ${req.url}`));
    await new Promise<void>((r) => upstreamHttp.listen(0, "127.0.0.1", r));
    const tcpPort = (upstream.address() as net.AddressInfo).port;
    const httpPort = (upstreamHttp.address() as net.AddressInfo).port;

    proxy = createEgressProxy({
      policyDir,
      operatorAllow: ["*.example"],
      lookup: async (host) => (dns[host] ?? []).map((address) => ({ address, family: 4 })),
      // Only reached for vetted public IPs; redirect them to the local stand-ins.
      dial: (ip, port) => {
        dials.push(`${ip}:${port}`);
        return net.connect(port === 443 ? tcpPort : httpPort, "127.0.0.1");
      },
      log: () => undefined,
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    proxy?.close();
    upstream?.close();
    upstreamHttp?.close();
    await rm(policyDir, { recursive: true, force: true });
  });

  /** Send a CONNECT and return the status line plus the open socket. */
  function connect(target: string): Promise<{ status: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        const end = buf.indexOf("\r\n\r\n");
        if (end !== -1) {
          socket.off("data", onData);
          resolve({ status: buf.split("\r\n")[0] ?? "", socket });
        }
      };
      socket.on("data", onData);
      socket.on("error", reject);
    });
  }

  it("tunnels CONNECT to an allowed domain on 443", async () => {
    const { status, socket } = await connect("allowed.example:443");
    expect(status).toMatch(/^HTTP\/1\.1 200/);
    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString()));
      socket.write("ping");
    });
    expect(echoed).toBe("ping");
    socket.destroy();
    expect(dials).toContain("93.184.216.34:443");
  });

  it.each([
    ["an undeclared host", "other.example:443"],
    ["a host that also resolves to a private IP (DNS rebinding)", "rebind.example:443"],
    ["the metadata IP", "169.254.169.254:80"],
    ["a private IP literal", "10.0.0.5:443"],
    ["a non-HTTPS port", "allowed.example:22"],
    ["an unresolvable host", "nowhere.example:443"],
  ])("refuses CONNECT to %s with 403", async (_label, target) => {
    const before = dials.length;
    const { status, socket } = await connect(target);
    socket.destroy();
    expect(status).toMatch(/^HTTP\/1\.1 403/);
    expect(dials.length).toBe(before);
  });

  it("forwards plain-HTTP requests to allowed domains and refuses others", async () => {
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    const ok = await get("http://allowed.example/hello?x=1");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("upstream saw allowed.example /hello?x=1");
    expect((await get("http://other.example/")).status).toBe(403);
    expect((await get("http://169.254.169.254/latest/meta-data/")).status).toBe(403);
  });

  it("refuses clients that are not a known app (unknown source subnet)", async () => {
    const strict = createEgressProxy({
      policyDir,
      operatorAllow: ["*"],
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dial: () => {
        throw new Error("must not dial");
      },
      log: () => undefined,
      // Pretend every client comes from an address outside all app subnets.
      sourceAddress: () => "172.31.99.99",
    });
    await new Promise<void>((r) => strict.listen(0, "127.0.0.1", r));
    const port = (strict.address() as net.AddressInfo).port;
    const status = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n"));
      s.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0] ?? "");
        s.destroy();
      });
    });
    strict.close();
    expect(status).toMatch(/^HTTP\/1\.1 403/);
  });
});

describe("operator policy default (T2.1b: allow declared domains)", () => {
  it.each([
    [undefined, ["*"]],
    ["", ["*"]],
    ["  ", ["*"]],
    ["*", ["*"]],
    ["none", []],
    [" NONE ", []],
    ["api.github.com, *.googleapis.com", ["api.github.com", "*.googleapis.com"]],
  ])("EGRESS_ALLOWED_DOMAINS=%j means %j", (raw, expected) => {
    expect(parseOperatorAllow(raw)).toEqual(expected);
  });

  it("refuses a list that mixes none with domains instead of guessing", () => {
    expect(() => parseOperatorAllow("none,api.github.com")).toThrow(/none/);
  });

  it("describes the policy for the startup log", () => {
    expect(describeOperatorPolicy(["*"])).toMatch(/any domain an app declares/);
    expect(describeOperatorPolicy([])).toMatch(/refused/);
    expect(describeOperatorPolicy(["a.com", "b.com"])).toMatch(/a\.com, b\.com/);
  });

  describe("through a real proxy server", () => {
    let policyDir: string;
    const servers: http.Server[] = [];
    let upstream: net.Server;
    const dns: Record<string, string[]> = {
      "declared.example": ["93.184.216.34"],
      "undeclared.example": ["93.184.216.35"],
      "private.example": ["10.0.0.7"],
    };

    beforeAll(async () => {
      policyDir = await mkdtemp(join(tmpdir(), "scad-egress-default-"));
      await writeFile(
        join(policyDir, "app-1.json"),
        JSON.stringify({ appId: "app-1", subnet: "127.0.0.1/32", allow: ["declared.example", "private.example"] }),
      );
      upstream = net.createServer((s) => s.pipe(s));
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    });

    afterAll(async () => {
      for (const s of servers) s.close();
      upstream?.close();
      await rm(policyDir, { recursive: true, force: true });
    });

    async function proxyFor(raw: string | undefined): Promise<number> {
      const tcpPort = (upstream.address() as net.AddressInfo).port;
      const server = createEgressProxy({
        policyDir,
        operatorAllow: parseOperatorAllow(raw),
        lookup: async (host) => (dns[host] ?? []).map((address) => ({ address, family: 4 })),
        dial: () => net.connect(tcpPort, "127.0.0.1"),
        log: () => undefined,
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return (server.address() as net.AddressInfo).port;
    }

    function connectStatus(port: number, target: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        s.once("data", (d) => {
          resolve(d.toString().split("\r\n")[0] ?? "");
          s.destroy();
        });
        s.on("error", reject);
      });
    }

    it("with the default (unset), a declared public domain works", async () => {
      expect(await connectStatus(await proxyFor(undefined), "declared.example:443")).toMatch(/^HTTP\/1\.1 200/);
    });

    it("with the default, an undeclared domain is refused", async () => {
      expect(await connectStatus(await proxyFor(undefined), "undeclared.example:443")).toMatch(/^HTTP\/1\.1 403/);
    });

    it("with the default, a declared domain that resolves to a private IP is refused", async () => {
      expect(await connectStatus(await proxyFor(""), "private.example:443")).toMatch(/^HTTP\/1\.1 403/);
    });

    it("none refuses everything, even declared public domains", async () => {
      expect(await connectStatus(await proxyFor("none"), "declared.example:443")).toMatch(/^HTTP\/1\.1 403/);
    });

    it("an explicit list still narrows what apps may declare", async () => {
      expect(await connectStatus(await proxyFor("other.example"), "declared.example:443")).toMatch(/^HTTP\/1\.1 403/);
    });
  });
});
