import { describe, expect, it } from "vitest";
import { chooseOciRuntime, hardenedHostConfig } from "./hardening.js";

const limits = { memoryMb: 256, cpuShares: 512, diskGb: 1, pids: 64 };

describe("hardenedHostConfig (INV6)", () => {
  it("drops all caps, blocks privilege gain, ro rootfs, and sets every limit", () => {
    const hc = hardenedHostConfig({ limits, networkMode: "scad-net-x", dataMount: { volume: "v" } });
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(["ALL"]);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.Privileged ?? false).toBe(false);
    expect(hc.SecurityOpt).toContain("no-new-privileges:true");
    expect(hc.Memory).toBe(256 * 1024 * 1024);
    // No swap on top of the memory limit.
    expect(hc.MemorySwap).toBe(256 * 1024 * 1024);
    expect(hc.CpuShares).toBe(512);
    expect(hc.PidsLimit).toBe(64);
    expect(hc.NetworkMode).toBe("scad-net-x");
    expect(hc.PortBindings).toBeUndefined();
    expect(hc.PublishAllPorts ?? false).toBe(false);
    expect(hc.Binds).toEqual(["v:/data:rw"]);
    expect(hc.Tmpfs?.["/tmp"]).toMatch(/noexec/);
    expect(hc.Runtime).toBeUndefined();
  });

  it("uses a size-capped tmpfs for /data when asked (smoke check never touches the real volume)", () => {
    const hc = hardenedHostConfig({ limits, networkMode: "n", dataMount: { tmpfsMb: 64 } });
    expect(hc.Binds ?? []).toEqual([]);
    expect(hc.Tmpfs?.["/data"]).toMatch(/size=64m/);
    expect(hc.Tmpfs?.["/data"]).toMatch(/nosuid/);
  });

  it("sets the OCI runtime when one is chosen", () => {
    const hc = hardenedHostConfig({ limits, networkMode: "n", dataMount: { tmpfsMb: 8 }, ociRuntime: "runsc" });
    expect(hc.Runtime).toBe("runsc");
  });
});

describe("chooseOciRuntime", () => {
  it("auto uses runsc when Docker has it", () => {
    expect(chooseOciRuntime(["runc", "runsc"], undefined)).toBe("runsc");
    expect(chooseOciRuntime(["runc", "runsc"], "auto")).toBe("runsc");
  });

  it("auto falls back to Docker's default when runsc is missing", () => {
    expect(chooseOciRuntime(["runc", "io.containerd.runc.v2"], undefined)).toBeUndefined();
  });

  it("runc forces the default even when runsc exists", () => {
    expect(chooseOciRuntime(["runc", "runsc"], "runc")).toBeUndefined();
  });

  it("runsc required but missing is an error, not a silent downgrade", () => {
    expect(() => chooseOciRuntime(["runc"], "runsc")).toThrow(/runsc/);
  });

  it("rejects unknown values", () => {
    expect(() => chooseOciRuntime(["runc"], "kata; rm -rf /")).toThrow(/SCAD_OCI_RUNTIME/);
  });
});
