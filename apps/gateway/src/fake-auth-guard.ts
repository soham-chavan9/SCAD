import { isLocalhostBase } from "./host.js";

/**
 * GATEWAY_FAKE_AUTH must never be enabled outside localhost-based BASE_DOMAIN.
 * Call before listening so a misconfigured production gateway refuses to start.
 */
export function assertFakeAuthAllowed(opts: {
  fakeAuth: boolean;
  baseDomain: string;
}): void {
  if (!opts.fakeAuth) return;
  if (!isLocalhostBase(opts.baseDomain)) {
    throw new Error(
      `GATEWAY_FAKE_AUTH=1 is refused when BASE_DOMAIN=${opts.baseDomain} (must be localhost-based)`,
    );
  }
}
