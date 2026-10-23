import type { FastifyReply } from "fastify";
import { isLocalhostBase } from "./host.js";

export const SESSION_COOKIE = "scad_session";

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
