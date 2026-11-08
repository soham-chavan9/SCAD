export const PACKAGE_NAME = "egress-proxy" as const;

export {
  createEgressProxy,
  hostAllowed,
  isBlockedAddress,
  loadPolicies,
  PolicyIndex,
  type AppPolicy,
  type EgressProxyOptions,
} from "./proxy.js";
