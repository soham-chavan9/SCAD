export const PACKAGE_NAME = "shared" as const;

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
  MANIFEST_CAPS,
  MANIFEST_DEFAULTS,
  manifestSchema,
  parseManifest,
  type ManifestInput,
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
  IDENTITY_JWT_TTL_SECONDS,
  importPrivateKeyPem,
  importPublicKeyPem,
  signIdentityJwt,
  verifyIdentityJwt,
  type IdentityClaims,
  type SignIdentityOptions,
  type VerifiedIdentity,
} from "./jwt.js";

export { isUuid, newId, uuidSchema } from "./id.js";
