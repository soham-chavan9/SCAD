import * as oidc from "openid-client";
import type {
  AuthorizationCallback,
  AuthorizationRequest,
  GithubProfile,
  IdentityProvider,
} from "./identity.js";

export type GithubOidcOptions = {
  clientId: string;
  clientSecret: string;
};

/**
 * GitHub OAuth using openid-client Configuration (OAuth 2.0 + PKCE + state).
 * GitHub is not a full OIDC OP; endpoints are configured manually.
 */
export class GithubIdentityProvider implements IdentityProvider {
  readonly #config: oidc.Configuration;

  constructor(opts: GithubOidcOptions) {
    this.#config = new oidc.Configuration(
      {
        issuer: "https://github.com",
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token",
        userinfo_endpoint: "https://api.github.com/user",
      },
      opts.clientId,
      undefined,
      oidc.ClientSecretPost(opts.clientSecret),
    );
  }

  async getAuthorizationUrl(req: AuthorizationRequest): Promise<URL> {
    const codeChallenge = await oidc.calculatePKCECodeChallenge(req.codeVerifier);
    return oidc.buildAuthorizationUrl(this.#config, {
      redirect_uri: req.redirectUri,
      scope: "read:user user:email",
      state: req.state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
  }

  async exchangeCode(cb: AuthorizationCallback): Promise<GithubProfile> {
    const callbackUrl = new URL(cb.redirectUri);
    callbackUrl.searchParams.set("code", cb.code);
    // state validated by caller before exchange

    const tokens = await oidc.authorizationCodeGrant(this.#config, callbackUrl, {
      pkceCodeVerifier: cb.codeVerifier,
      idTokenExpected: false,
    });

    const accessToken = tokens.access_token;
    if (!accessToken) {
      throw new Error("GitHub token response missing access_token");
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "scad-gateway",
      },
    });
    if (!userRes.ok) {
      throw new Error(`GitHub user lookup failed: ${userRes.status}`);
    }
    const user = (await userRes.json()) as {
      id: number;
      login: string;
      name: string | null;
      email: string | null;
    };

    let email = user.email;
    if (!email) {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "scad-gateway",
        },
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        email =
          emails.find((e) => e.primary && e.verified)?.email ??
          emails.find((e) => e.verified)?.email ??
          null;
      }
    }
    if (!email) {
      throw new Error("GitHub account has no verified email");
    }

    return {
      githubId: String(user.id),
      login: user.login,
      email,
      name: user.name ?? "",
    };
  }
}
