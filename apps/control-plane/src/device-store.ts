import { createHash, randomBytes } from "node:crypto";

export type DevicePending = {
  deviceCode: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  authorizedUserId?: string;
  patToken?: string;
  /** T3.4: approval by emailed link. Only the token's hash is kept. */
  emailApproval?: { tokenHash: string; email: string };
};

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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

  /**
   * Bind a one-time approval link to a pending code, for `email` (T3.4).
   * Returns the token for the link; a second call replaces the first link.
   */
  issueEmailApproval(userCode: string, email: string): string | undefined {
    const pending = this.getByUserCode(userCode);
    if (!pending) return undefined;
    const token = randomBytes(32).toString("base64url");
    pending.emailApproval = { tokenHash: hashToken(token), email };
    return token;
  }

  /** Look up an approval link without using it (the confirm page). */
  peekEmailApproval(token: string): { userCode: string; email: string } | undefined {
    const tokenHash = hashToken(token);
    for (const pending of this.#byDevice.values()) {
      if (pending.emailApproval?.tokenHash !== tokenHash) continue;
      if (!this.getByDeviceCode(pending.deviceCode)) return undefined;
      return { userCode: pending.userCode, email: pending.emailApproval.email };
    }
    return undefined;
  }

  /** Use an approval link: single use, expires with its device code. */
  takeEmailApproval(token: string): { userCode: string; email: string } | undefined {
    const found = this.peekEmailApproval(token);
    if (!found) return undefined;
    const pending = this.getByUserCode(found.userCode);
    if (pending) delete pending.emailApproval;
    return found;
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
