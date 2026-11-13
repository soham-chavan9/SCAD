export const PACKAGE_NAME = "shared" as const;

export {
  AppUrlError,
  assertFinalAppUrl,
  formatAppUrl,
  normalizeBaseDomain,
  type AppUrlErrorReason,
} from "./app-url.js";

export {
  ERROR_CODES,
  errorCodeSchema,
  errorEnvelopeSchema,
  makeError,
  parseErrorEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from "./error.js";

export {
  applyManifestDefaults,
  describeManifestIssues,
  MANIFEST_CAPS,
  MANIFEST_DEFAULTS,
  manifestSchema,
  parseManifest,
  type ManifestInput,
  type ManifestIssue,
  type ResolvedManifest,
} from "./manifest.js";

export {
  HANDLE_PATTERN,
  handleSchema,
  isHandle,
  isSlug,
  parseHandle,
  parseSlug,
  SLUG_PATTERN,
  slugSchema,
} from "./validators.js";

export {
  generateEd25519KeyPair,
  identityKeyId,
  IDENTITY_JWT_TTL_SECONDS,
  importPrivateKeyPem,
  importPublicKeyPem,
  normalizePemFromEnv,
  signIdentityJwt,
  verifyIdentityJwt,
  verifyIdentityJwtWithJwks,
  type IdentityClaims,
  type SignIdentityOptions,
  type VerifiedIdentity,
} from "./jwt.js";

export { isUuid, newId, uuidSchema } from "./id.js";

export {
  DEFAULT_CPU_SHARES,
  DEFAULT_PIDS,
  deploySpecFromManifest,
  startToArgv,
  type DeploySpecShape,
} from "./deploy-spec.js";

export { apiBaseUrlFor, apiHostFor, authHostFor, isLocalBaseDomain, schemeFor } from "./hosts.js";

export { describeLink, visibilityFor, type AppVisibility, type LinkKind } from "./visibility.js";
