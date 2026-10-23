/** GitHub (or test) identity after OAuth succeeds. */
export type GithubProfile = {
  githubId: string;
  login: string;
  email: string;
  name: string;
};

export type AuthorizationRequest = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
};

export type AuthorizationCallback = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

/**
 * Identity provider used by the auth host.
 * Production: GitHub via openid-client. Tests: FakeIdentityProvider.
 */
export interface IdentityProvider {
  getAuthorizationUrl(req: AuthorizationRequest): Promise<URL>;
  exchangeCode(cb: AuthorizationCallback): Promise<GithubProfile>;
}

/** In-memory GitHub stand-in for integration tests. */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #profiles = new Map<string, GithubProfile>();
  readonly #codes = new Map<string, string>();

  /** Register a profile and return an authorization code that exchanges to it. */
  issueCodeFor(profile: GithubProfile): string {
    const code = `fake_${profile.githubId}_${this.#codes.size}`;
    this.#profiles.set(profile.githubId, profile);
    this.#codes.set(code, profile.githubId);
    return code;
  }

  async getAuthorizationUrl(req: AuthorizationRequest): Promise<URL> {
    const url = new URL("https://github.test/login/oauth/authorize");
    url.searchParams.set("state", req.state);
    url.searchParams.set("redirect_uri", req.redirectUri);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  async exchangeCode(cb: AuthorizationCallback): Promise<GithubProfile> {
    const githubId = this.#codes.get(cb.code);
    if (!githubId) {
      throw new Error("invalid fake authorization code");
    }
    const profile = this.#profiles.get(githubId);
    if (!profile) {
      throw new Error("unknown fake profile");
    }
    return profile;
  }
}
