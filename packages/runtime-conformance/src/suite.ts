import { newId } from "@scad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeploySpec, RuntimeProvider } from "./types.js";

export type ConformanceContext = {
  provider: RuntimeProvider;
  /** Non-root image that serves HTTP on `port`. */
  imageRef: string;
  port?: number;
};

export type ConformanceFactory = () => Promise<ConformanceContext> | ConformanceContext;

function baseSpec(
  appId: string,
  imageRef: string,
  port: number,
  overrides: Partial<DeploySpec> = {},
): DeploySpec {
  return {
    appId,
    imageRef,
    port,
    env: {},
    egressAllow: [],
    limits: { memoryMb: 128, cpuShares: 512, diskGb: 1, pids: 64 },
    ...overrides,
  };
}

/**
 * Registers the shared RuntimeProvider conformance suite (AGENTS §4 / TASKS T0.4).
 * Call from a driver's vitest file.
 */
export function registerRuntimeConformance(driverName: string, factory: ConformanceFactory): void {
  describe(`RuntimeProvider conformance (${driverName})`, () => {
    let provider: RuntimeProvider;
    let imageRef: string;
    let port: number;
    const appIds: string[] = [];

    const track = (id: string) => {
      appIds.push(id);
      return id;
    };

    beforeAll(async () => {
      const ctx = await factory();
      provider = ctx.provider;
      imageRef = ctx.imageRef;
      port = ctx.port ?? 8080;
    }, 120_000);

    afterAll(async () => {
      for (const id of appIds) {
        try {
          await provider.remove(id, { deleteVolume: true });
        } catch {
          // best-effort cleanup
        }
      }
    }, 120_000);

    const timeout = 120_000;

    it(
      "ensureApp is idempotent",
      async () => {
        const appId = track(newId());
        await provider.ensureApp(appId, 1);
        await provider.ensureApp(appId, 1);
      },
      timeout,
    );

    it("deploy, status, address, start, stop, logs", async () => {
      const appId = track(newId());
      await provider.ensureApp(appId, 1);
      const machine = await provider.deploy(baseSpec(appId, imageRef, port));
      expect(machine.appId).toBe(appId);
      expect(machine.providerId.length).toBeGreaterThan(0);

      expect(await provider.status(machine)).toBe("running");

      const addr = await provider.address(machine);
      expect(addr.port).toBe(port);
      expect(addr.host.length).toBeGreaterThan(0);
      expect(addr.host).not.toBe("127.0.0.1");
      expect(addr.host).not.toBe("0.0.0.0");

      const lines: string[] = [];
      for await (const line of provider.logs(machine, { follow: false, tail: 50 })) {
        lines.push(line);
      }
      expect(Array.isArray(lines)).toBe(true);

      await provider.stop(machine);
      expect(await provider.status(machine)).toBe("stopped");

      await provider.start(machine);
      expect(await provider.status(machine)).toBe("running");
    }, timeout);

    it("deploy replaces a previous release", async () => {
      const appId = track(newId());
      await provider.ensureApp(appId, 1);
      const first = await provider.deploy(baseSpec(appId, imageRef, port));
      const second = await provider.deploy(
        baseSpec(appId, imageRef, port, { env: { SCAD_RELEASE: "2" } }),
      );
      expect(await provider.status(first)).toBe("missing");
      expect(await provider.status(second)).toBe("running");
      expect(second.providerId).not.toBe(first.providerId);
    }, timeout);

    it("remove without deleteVolume keeps volume for the next ensureApp", async () => {
      const appId = track(newId());
      await provider.ensureApp(appId, 1);
      const machine = await provider.deploy(baseSpec(appId, imageRef, port));
      await provider.remove(appId, { deleteVolume: false });
      expect(await provider.status(machine)).toBe("missing");

      await provider.ensureApp(appId, 1);
      const again = await provider.deploy(baseSpec(appId, imageRef, port));
      expect(await provider.status(again)).toBe("running");
    }, timeout);

    it("remove with deleteVolume cleans up", async () => {
      const appId = track(newId());
      await provider.ensureApp(appId, 1);
      const machine = await provider.deploy(baseSpec(appId, imageRef, port));
      await provider.remove(appId, { deleteVolume: true });
      expect(await provider.status(machine)).toBe("missing");
      await provider.ensureApp(appId, 1);
    }, timeout);

    it("status is missing for unknown machines", async () => {
      expect(
        await provider.status({ appId: newId(), providerId: "no-such-container" }),
      ).toBe("missing");
    });
  });
}
