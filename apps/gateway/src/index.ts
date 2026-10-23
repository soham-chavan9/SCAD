export const PACKAGE_NAME = "gateway" as const;

export { buildGateway } from "./app.js";
export { FakeIdentityProvider, type GithubProfile, type IdentityProvider } from "./auth/identity.js";
export { GithubIdentityProvider } from "./auth/github.js";
export { createHttpAppResolver, type AppResolver, type ResolvedApp } from "./resolve.js";
export { parseHost, appHost, authHost } from "./host.js";
export { SESSION_COOKIE, sessionCookieOptions } from "./cookies.js";
export { issueLoginCode, consumeLoginCode, LoginCodeError } from "./auth/login-codes.js";
