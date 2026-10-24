import type { FastifyReply } from "fastify";
import { isLocalhostBase } from "./host.js";

export const SESSION_COOKIE = "scad_session";
export const OAUTH_STATE_COOKIE = "scad_oauth_state";

export function sessionCookieOptions(baseDomain: string): {
  path: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  /** Intentionally omitted Domain — host-only cookies (INV4). */
} {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: !isLocalhostBase(baseDomain),
  };
}

export function oauthStateCookieOptions(baseDomain: string): {
  path: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
} {
  return {
    ...sessionCookieOptions(baseDomain),
    maxAge: 10 * 60,
  };
}

export function clearOauthStateCookie(reply: FastifyReply, baseDomain: string): void {
  reply.clearCookie(OAUTH_STATE_COOKIE, sessionCookieOptions(baseDomain));
}

export function clearSessionCookie(reply: FastifyReply, baseDomain: string): void {
  reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(baseDomain));
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  baseDomain: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    ...sessionCookieOptions(baseDomain),
    expires: expiresAt,
  });
}
