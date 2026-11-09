import { createSign } from "node:crypto";

export interface GitHubAppConfig {
  appId: string;
  /** The App's private key, PEM. */
  privateKey: string;
  clientId: string;
  clientSecret: string;
  /** `https://api.github.com`, or a GitHub Enterprise Server's `/api/v3`. */
  apiUrl?: string;
  /** `https://github.com`, where device flow and OAuth live. */
  webUrl?: string;
}

export interface UserTokens {
  access_token: string;
  refresh_token?: string;
  /** Seconds until the access token expires. */
  expires_in?: number;
  /** Seconds until the refresh token expires. */
  refresh_token_expires_in?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

export type Access = "read" | "denied" | "invalid";

/** The App is not installed on the repository's owner, or not given that repository. */
/** An open pull request, as pushed work shows it. */
export interface PullRequest {
  url: string;
  title: string;
}

export class NotInstalledError extends Error {
  constructor(repo: string) {
    super(`the GitHub App is not installed for ${repo}`);
  }
}

/** `github.com/acme/api` → `acme/api`. */
const fullName = (repo: string) => repo.split("/").slice(1).join("/");

/** Refresh an installation token this long before GitHub expires it. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * The instance's GitHub App (ADR 0004, amended): installation tokens for the mirror and
 * PR lookups, and the client credentials behind user sign-in.
 */
export class GitHubApp {
  readonly config: Required<GitHubAppConfig>;
  readonly #installations = new Map<string, number>();
  readonly #tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(config: GitHubAppConfig) {
    this.config = { apiUrl: "https://api.github.com", webUrl: "https://github.com", ...config };
  }

  /** A short-lived RS256 JWT identifying the App itself. */
  #jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.config.appId })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.config.privateKey);
    return `${unsigned}.${signature.toString("base64url")}`;
  }

  async #api(path: string, init: RequestInit & { token: string }): Promise<Response> {
    return fetch(`${this.config.apiUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${init.token}`,
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });
  }

  async #json<T>(response: Response, what: string): Promise<T> {
    if (!response.ok)
      throw new Error(`GitHub ${what}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  /** An installation token that can read `repo`, cached until shortly before it expires. */
  async installationToken(repo: string): Promise<string> {
    let installation = this.#installations.get(repo);
    if (installation === undefined) {
      const res = await this.#api(`/repos/${fullName(repo)}/installation`, { token: this.#jwt() });
      if (res.status === 404) {
        await res.body?.cancel();
        throw new NotInstalledError(repo);
      }
      installation = (await this.#json<{ id: number }>(res, `installation for ${repo}`)).id;
      this.#installations.set(repo, installation);
    }
    const cached = this.#tokens.get(installation);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token;
    const res = await this.#api(`/app/installations/${installation}/access_tokens`, {
      method: "POST",
      token: this.#jwt(),
    });
    const { token, expires_at } = await this.#json<{ token: string; expires_at: string }>(
      res,
      "installation token",
    );
    this.#tokens.set(installation, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  remoteUrl(repo: string): string {
    return `https://${repo}.git`;
  }

  /** Git configuration authenticating as the App's installation; passed by environment, never argv. */
  async gitConfig(repo: string): Promise<Record<string, string>> {
    const token = await this.installationToken(repo);
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return { "http.extraHeader": `Authorization: Basic ${basic}` };
  }

  /** Open pull requests whose head is a branch of `repo` itself: branch → its URL and title. */
  async openPullRequests(repo: string): Promise<Map<string, PullRequest>> {
    const token = await this.installationToken(repo);
    const result = new Map<string, PullRequest>();
    for (let page = 1; ; page++) {
      const res = await this.#api(
        `/repos/${fullName(repo)}/pulls?state=open&per_page=100&page=${page}`,
        { token },
      );
      const pulls = await this.#json<
        {
          html_url: string;
          title: string;
          head: { ref: string; repo: { full_name: string } | null };
        }[]
      >(res, `pulls for ${repo}`);
      for (const pull of pulls) {
        if (pull.head.repo?.full_name === fullName(repo)) {
          result.set(pull.head.ref, { url: pull.html_url, title: pull.title });
        }
      }
      if (pulls.length < 100) return result;
    }
  }

  /** Whether the holder of a user token can read `repo`. */
  /**
   * What a user's own token may do with a repository: read it, not (GitHub hides private
   * repositories as 404), or nothing at all because GitHub does not accept the token.
   */
  async access(userToken: string, repo: string): Promise<Access> {
    const res = await this.#api(`/repos/${fullName(repo)}`, { token: userToken });
    await res.body?.cancel();
    if (res.ok) return "read";
    if (res.status === 401) return "invalid";
    // A spent rate limit is also a 403; it says nothing about the user's access.
    const limited = res.headers.get("x-ratelimit-remaining") === "0";
    if ((res.status === 403 && !limited) || res.status === 404) return "denied";
    throw new Error(`GitHub repository lookup: ${res.status}`);
  }

  /** Where to send a browser to sign in: GitHub's authorize page, with PKCE. */
  authorizeUrl(options: { state: string; challenge: string; redirectUri: string }): string {
    const url = new URL("/login/oauth/authorize", this.config.webUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("state", options.state);
    url.searchParams.set("code_challenge", options.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Exchanges a web-flow code, with the PKCE verifier and the App's client secret. */
  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<UserTokens> {
    return this.#tokenRequest(
      { code, code_verifier: verifier, redirect_uri: redirectUri },
      "code exchange",
    );
  }

  async user(userToken: string): Promise<GitHubUser> {
    return this.#json(await this.#api("/user", { token: userToken }), "user");
  }

  /** The user's verified emails; needs the App's "Email addresses: read" permission. */
  async emails(userToken: string): Promise<string[]> {
    const emails = await this.#json<{ email: string; verified: boolean }[]>(
      await this.#api("/user/emails", { token: userToken }),
      "user emails",
    );
    return emails.filter((e) => e.verified).map((e) => e.email);
  }

  async #tokenRequest(form: Record<string, string>, what: string): Promise<UserTokens> {
    const res = await fetch(`${this.config.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...form,
      }),
    });
    const body = await this.#json<UserTokens & { error?: string }>(res, what);
    if (body.error) throw new Error(`GitHub ${what}: ${body.error}`);
    return body;
  }

  /** Exchanges a user's refresh token for new tokens; the client secret never leaves the server. */
  async refresh(refreshToken: string): Promise<UserTokens> {
    return this.#tokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      "token refresh",
    );
  }
}
