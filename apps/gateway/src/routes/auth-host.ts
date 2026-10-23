import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Db } from "@scad/control-plane";
import type { IdentityProvider } from "../auth/identity.js";
import { createOauthState, takeOauthState } from "../auth/oauth-state.js";
import { issueLoginCode } from "../auth/login-codes.js";
import { upsertGithubUser } from "../auth/users.js";
import { authHost } from "../host.js";
import { badCallbackPage } from "../pages.js";

export type AuthHostOpts = {
  db: Db["db"];
  baseDomain: string;
  identity: IdentityProvider;
  /** When set, /login/dev completes OAuth with this code (tests only). */
  allowDevLogin?: boolean;
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
  return { appHost: host, returnToUrl: url };
}

export const authHostRoutes: FastifyPluginAsync<AuthHostOpts> = async (app, opts) => {
  const redirectUri = () =>
    `${publicOrigin(opts.baseDomain, authHost(opts.baseDomain))}/oauth/github/callback`;

  app.get("/login", async (request, reply) => {
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
    return reply.redirect(url.toString());
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
      return reply.status(400).type("text/html").send(badCallbackPage(query.error));
    }
    if (!query.code || !query.state) {
      return reply.status(400).type("text/html").send(badCallbackPage("Missing code or state"));
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

    if (user.status !== "active") {
      return reply.status(403).type("text/html").send(badCallbackPage("Account suspended"));
    }

    const returnTo = new URL(oauth.returnTo);
    const appHostName = returnTo.host.toLowerCase();
    const loginCode = await issueLoginCode(opts.db, {
      userId: user.id,
      appHost: appHostName,
    });

    const proto = opts.baseDomain.startsWith("localhost") ? "http" : "https";
    const callback = new URL(`${proto}://${appHostName}/__scad/callback`);
    callback.searchParams.set("code", loginCode);
    callback.searchParams.set("return_to", returnTo.pathname + returnTo.search);

    return reply.redirect(callback.toString());
  }
};
