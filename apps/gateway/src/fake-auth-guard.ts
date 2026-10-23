import { isLocalhostBase } from "./host.js";

/**
 * GATEWAY_FAKE_AUTH must never run against a non-localhost BASE_DOMAIN.
 * Call before the gateway listens.
 */
export function assertFakeAuthAllowed(opts: {
  fakeAuth: boolean;
  baseDomain: string;
}): void {
  if (!opts.fakeAuth) {
    return;
  }
  if (!isLocalhostBase(opts.baseDomain)) {
    throw new Error(
      `GATEWAY_FAKE_AUTH=1 is only allowed when BASE_DOMAIN is localhost-based (got ${opts.baseDomain})`,
    );
  }
}
