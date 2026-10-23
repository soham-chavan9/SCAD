import { randomBytes } from "node:crypto";

export type DevicePending = {
  deviceCode: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  authorizedUserId?: string;
  patToken?: string;
};

/** In-memory device-code store (single control-plane process; fine for local M0). */
export class DeviceStore {
  readonly #byDevice = new Map<string, DevicePending>();
  readonly #byUser = new Map<string, string>();

  create(opts?: { ttlSeconds?: number; intervalSeconds?: number }): DevicePending {
    const ttlSeconds = opts?.ttlSeconds ?? 600;
    const intervalSeconds = opts?.intervalSeconds ?? 1;
    const deviceCode = randomBytes(24).toString("base64url");
    const userCode = randomBytes(4).toString("hex").toUpperCase();
    const pending: DevicePending = {
      deviceCode,
      userCode,
      intervalSeconds,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    this.#byDevice.set(deviceCode, pending);
    this.#byUser.set(userCode, deviceCode);
    return pending;
  }

  getByDeviceCode(deviceCode: string): DevicePending | undefined {
    const pending = this.#byDevice.get(deviceCode);
    if (!pending) return undefined;
    if (Date.now() > pending.expiresAt) {
      this.#delete(pending);
      return undefined;
    }
    return pending;
  }

  getByUserCode(userCode: string): DevicePending | undefined {
    const deviceCode = this.#byUser.get(userCode.toUpperCase());
    if (!deviceCode) return undefined;
    return this.getByDeviceCode(deviceCode);
  }

  authorize(userCode: string, userId: string, patToken: string): boolean {
    const pending = this.getByUserCode(userCode);
    if (!pending) return false;
    pending.authorizedUserId = userId;
    pending.patToken = patToken;
    return true;
  }

  consumePat(deviceCode: string): string | "pending" | "expired" {
    const pending = this.getByDeviceCode(deviceCode);
    if (!pending) return "expired";
    if (!pending.patToken) return "pending";
    const token = pending.patToken;
    this.#delete(pending);
    return token;
  }

  #delete(pending: DevicePending): void {
    this.#byDevice.delete(pending.deviceCode);
    this.#byUser.delete(pending.userCode);
  }
}
