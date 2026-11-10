import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@scad/control-plane";
import type { IdentityProvider } from "../auth/identity.js";
import {
  MagicLinkError,
  consumeMagicLink,
  createMagicLink,
  findUserByEmail,
  isSharedEmail,
  normalizeEmail,
} from "../auth/magic-links.js";
import { createOauthState, takeOauthState } from "../auth/oauth-state.js";
import { issueLoginCode } from "../auth/login-codes.js";
import {
  MAGIC_LINK_PER_EMAIL,
  MAGIC_LINK_PER_IP,
  MAGIC_LINK_WINDOW_MS,
  SlidingWindowLimiter,
} from "../auth/rate-limit.js";
import { createEmailUser, upsertGithubUser, type GatewayUser } from "../auth/users.js";
import {
  CSRF_COOKIE,
  OAUTH_STATE_COOKIE,
  clearOauthStateCookie,
  csrfCookieOptions,
  oauthStateCookieOptions,
} from "../cookies.js";
import { randomToken } from "../crypto.js";
import { authHost } from "../host.js";
import { safeLocalReturnPath } from "../return-path.js";
import { jwksResponse } from "../identity/headers.js";
import type { IdentityKeyMaterial } from "../identity/keys.js";
import type { Mailer } from "../mail/mailer.js";
import {
  badCallbackPage,
  checkEmailPage,
  confirmMagicLinkPage,
  loginPage,
  rateLimitedPage,
} from "../pages.js";

export type AuthHostOpts = {
  db: Db["db"];
  baseDomain: string;
  identity: IdentityProvider;
  keys: IdentityKeyMaterial;
  /** When set, /login/dev completes OAuth with this code (tests only). */
  allowDevLogin?: boolean;
  /** Sends magic-link emails. */
  mailer: Mailer;
  /** Clock (tests). */
  now: () => Date;
};

function publicOrigin(baseDomain: string, host: string): string {
  const proto = baseDomain.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

function parseReturnTo(
  returnTo: string | undefined,
  baseDomain: string,
): { appHost: string; returnToUrl: URL } | null {
  if (!returnTo) return null;
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  if (!host.endsWith(`.${baseDomain}`) || host.startsWith("auth.")) {
    return null;
  }
  if (!safeLocalReturnPath(url.pathname + url.search)) {
    return null;
  }
  return { appHost: host, returnToUrl: url };
}

const emailRequestBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  return_to: z.string().min(1).max(2048),
  csrf: z.string().min(1).max(200),
});

const verifyBody = z.object({
  token: z.string().min(1).max(200),
  csrf: z.string().min(1).max(200),
});

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const authHostRoutes: FastifyPluginAsync<AuthHostOpts> = async (app, opts) => {
  const redirectUri = () =>
    `${publicOrigin(opts.baseDomain, authHost(opts.baseDomain))}/oauth/github/callback`;

  const perEmail = new SlidingWindowLimiter({
    limit: MAGIC_LINK_PER_EMAIL,
    windowMs: MAGIC_LINK_WINDOW_MS,
  });
  const perIp = new SlidingWindowLimiter({
    limit: MAGIC_LINK_PER_IP,
    windowMs: MAGIC_LINK_WINDOW_MS,
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  /** Reuse the browser's CSRF token if it has one, else mint and set it. */
  function csrfToken(request: FastifyRequest, reply: FastifyReply): string {
    const existing = request.cookies[CSRF_COOKIE];
    if (existing && /^[A-Za-z0-9_-]{20,100}$/.test(existing)) return existing;
    const token = randomToken(24);
    reply.setCookie(CSRF_COOKIE, token, csrfCookieOptions(opts.baseDomain));
    return token;
  }

  app.get("/.well-known/jwks.json", async () => jwksResponse(opts.keys));

  app.get("/login", async (request, reply) => {
    const query = request.query as { return_to?: string };
    const parsed = parseReturnTo(query.return_to, opts.baseDomain);
    if (!parsed) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing or invalid return_to"));
    }
    const csrf = csrfToken(request, reply);
    return reply
      .type("text/html")
      .send(loginPage({ returnTo: parsed.returnToUrl.toString(), csrf }));
  });

  app.get("/login/github", async (request, reply) => {
    const query = request.query as { return_to?: string };
    const parsed = parseReturnTo(query.return_to, opts.baseDomain);
    if (!parsed) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing or invalid return_to"));
    }

    const { state, codeVerifier } = await createOauthState(opts.db, parsed.returnToUrl.toString());
    const url = await opts.identity.getAuthorizationUrl({
      state,
      codeVerifier,
      redirectUri: redirectUri(),
    });
    reply.setCookie(OAUTH_STATE_COOKIE, state, oauthStateCookieOptions(opts.baseDomain));
    return reply.redirect(url.toString());
  });

  app.post("/login/email", async (request, reply) => {
    const parsed = emailRequestBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).type("text/html").send(badCallbackPage("Enter a valid email address"));
    }
    if (!sameToken(request.cookies[CSRF_COOKIE], parsed.data.csrf)) {
      return reply.status(403).type("text/html").send(badCallbackPage("Form expired. Go back and try again."));
    }
    const target = parseReturnTo(parsed.data.return_to, opts.baseDomain);
    if (!target) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing or invalid return_to"));
    }

    const email = normalizeEmail(parsed.data.email);
    const now = opts.now();
    // Both limits apply to every request, known email or not (no enumeration).
    const ipOk = perIp.take(`ip:${request.ip}`, now);
    const emailOk = ipOk && perEmail.take(`email:${email}`, now);
    if (!ipOk || !emailOk) {
      return reply
        .status(429)
        .header("retry-after", String(MAGIC_LINK_WINDOW_MS / 1000))
        .type("text/html")
        .send(rateLimitedPage());
    }

    // Links go to existing active users, and to emails an app was shared with
    // (their account is created on first sign-in). Nobody else gets mail.
    const user = await findUserByEmail(opts.db, email);
    const canSignIn = user ? user.status === "active" : await isSharedEmail(opts.db, email);
    if (canSignIn) {
      const token = await createMagicLink(opts.db, {
        email,
        appHost: target.appHost,
        returnTo: target.returnToUrl.toString(),
        now,
      });
      const link = new URL(
        `${publicOrigin(opts.baseDomain, authHost(opts.baseDomain))}/login/email/verify`,
      );
      link.searchParams.set("token", token);
      // Not awaited: known and unknown emails answer in the same time.
      void opts.mailer
        .send({
          to: email,
          subject: `Sign in to ${target.appHost}`,
          text: `Open this link to sign in to ${target.appHost}:\n\n${link.toString()}\n\nIt works once and expires in 10 minutes. If you did not ask for it, ignore this email.\n`,
        })
        .catch((err: unknown) => {
          // Never log the link or token (INV12).
          console.error("magic link email failed:", err instanceof Error ? err.name : "error");
        });
    }

    return reply.type("text/html").send(checkEmailPage());
  });

  app.get("/login/email/verify", async (request, reply) => {
    const query = request.query as { token?: string };
    if (!query.token || query.token.length > 200) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing sign-in link token"));
    }
    const csrf = csrfToken(request, reply);
    return reply
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store")
      .type("text/html")
      .send(confirmMagicLinkPage({ token: query.token, csrf }));
  });

  app.post("/login/email/verify", async (request, reply) => {
    const parsed = verifyBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing sign-in link token"));
    }
    if (!sameToken(request.cookies[CSRF_COOKIE], parsed.data.csrf)) {
      return reply.status(403).type("text/html").send(badCallbackPage("Form expired. Open the link again."));
    }
    let link;
    try {
      link = await consumeMagicLink(opts.db, { token: parsed.data.token, now: opts.now() });
    } catch (err) {
      if (err instanceof MagicLinkError) {
        const msg =
          err.reason === "expired"
            ? "This sign-in link has expired. Ask for a new one."
            : err.reason === "used"
              ? "This sign-in link was already used. Ask for a new one."
              : "This sign-in link is not valid.";
        return reply.status(400).type("text/html").send(badCallbackPage(msg));
      }
      throw err;
    }
    let user = await findUserByEmail(opts.db, link.email);
    if (!user && (await isSharedEmail(opts.db, link.email))) {
      // First sign-in for a shared email: create the account (T1.2).
      user = await createEmailUser(opts.db, link.email);
    }
    if (!user) {
      return reply.status(400).type("text/html").send(badCallbackPage("This sign-in link is not valid."));
    }
    return finishSignIn(user, link.returnTo, reply);
  });

  /** Test-only: finish OAuth without GitHub by posting a fake code + state. */
  if (opts.allowDevLogin) {
    app.post("/login/dev/callback", async (request, reply) => {
      const body = request.body as { code?: string; state?: string };
      if (!body.code || !body.state) {
        return reply.status(400).send({ error: "code and state required" });
      }
      return completeOauth(body.code, body.state, reply);
    });
  }

  app.get("/oauth/github/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      return reply.status(400).type("text/html").send(badCallbackPage("GitHub sign-in was cancelled"));
    }
    if (!query.code || !query.state) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing code or state"));
    }
    const cookieState = request.cookies[OAUTH_STATE_COOKIE];
    clearOauthStateCookie(reply, opts.baseDomain);
    if (!cookieState || cookieState !== query.state) {
      return reply
        .status(400)
        .type("text/html")
        .send(badCallbackPage("Missing or mismatched OAuth state"));
    }
    return completeOauth(query.code, query.state, reply);
  });

  async function completeOauth(code: string, state: string, reply: FastifyReply) {
    const oauth = await takeOauthState(opts.db, state);
    if (!oauth) {
      return reply.status(400).type("text/html").send(badCallbackPage("Invalid or expired state"));
    }

    let profile;
    try {
      profile = await opts.identity.exchangeCode({
        code,
        codeVerifier: oauth.codeVerifier,
        redirectUri: redirectUri(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth exchange failed";
      return reply.status(400).type("text/html").send(badCallbackPage(message));
    }

    let user;
    try {
      user = await upsertGithubUser(opts.db, profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : "User upsert failed";
      return reply.status(400).type("text/html").send(badCallbackPage(message));
    }

    return finishSignIn(user, oauth.returnTo, reply);
  }

  /** Shared tail of every sign-in: one-time login code bound to the app host (§9 step 3). */
  async function finishSignIn(user: GatewayUser, returnToRaw: string, reply: FastifyReply) {
    if (user.status !== "active") {
      return reply.status(403).type("text/html").send(badCallbackPage("Account suspended"));
    }

    const returnTo = new URL(returnToRaw);
    const appHostName = returnTo.host.toLowerCase();
    const localReturn = safeLocalReturnPath(returnTo.pathname + returnTo.search);
    if (!localReturn) {
      return reply.status(400).type("text/html").send(badCallbackPage("Invalid return_to"));
    }
    const loginCode = await issueLoginCode(opts.db, {
      userId: user.id,
      appHost: appHostName,
    });

    const proto = opts.baseDomain.startsWith("localhost") ? "http" : "https";
    const callback = new URL(`${proto}://${appHostName}/__scad/callback`);
    callback.searchParams.set("code", loginCode);
    callback.searchParams.set("return_to", localReturn);

    return reply.redirect(callback.toString());
  }
};
