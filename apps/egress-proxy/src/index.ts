export const PACKAGE_NAME = "egress-proxy" as const;

export {
  createEgressProxy,
  describeOperatorPolicy,
  hostAllowed,
  isBlockedAddress,
  loadPolicies,
  parseOperatorAllow,
  PolicyIndex,
  type AppPolicy,
  type EgressProxyOptions,
} from "./proxy.js";
