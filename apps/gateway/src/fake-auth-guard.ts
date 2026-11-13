import { isLocalhostBase } from "./host.js";

/**
 * GATEWAY_FAKE_AUTH must never run against a non-localhost BASE_DOMAIN.
 * Call before the gateway listens.
 */
export function assertFakeAuthAllowed(opts: {
  fakeAuth: boolean;
  baseDomain: string;
  /** `NODE_ENV=production` (deploy/): fake auth is refused whatever BASE_DOMAIN says (T3.1). */
  production?: boolean;
}): void {
  if (!opts.fakeAuth) {
    return;
  }
  if (opts.production) {
    throw new Error("GATEWAY_FAKE_AUTH=1 is refused in production (NODE_ENV=production); unset it");
  }
  if (!isLocalhostBase(opts.baseDomain)) {
    throw new Error(
      `GATEWAY_FAKE_AUTH=1 is only allowed when BASE_DOMAIN is localhost-based (got ${opts.baseDomain})`,
    );
  }
}
