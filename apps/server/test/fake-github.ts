import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface FakePull {
  head: string;
  /** The head's repository, `owner/name`; a fork's differs from the base's. */
  headRepo?: string;
  number: number;
}

/**
 * Just enough of GitHub for Highground: App installation tokens (checking the App's
 * RS256 JWT), open pull requests, repository read access for user tokens, and the
 * device flow. Every request is recorded.
 */
export class FakeGitHub {
  readonly appId = "4242";
  readonly clientId = "Iv1.fake";
  readonly clientSecret = "fake-secret";
  readonly privateKey: string;
  readonly requests: string[] = [];
  /** `owner/name` → open pulls. */
  readonly pulls = new Map<string, FakePull[]>();
  /** User token → the `owner/name`s it can read. */
  readonly users = new Map<string, Set<string>>();
  /** Device codes the "user" has approved, → the token they get. */
  readonly approved = new Map<string, string>();
  /** User tokens whose rate limit is spent. */
  readonly rateLimited = new Set<string>();
  /** When set, every device-flow poll answers with this error (`access_denied`, `expired_token`). */
  deviceError: string | undefined;
  /** When set, every device code is approved with this token after one pending poll. */
  autoApprove: string | undefined;
  /** Refresh token → the token a refresh issues. */
  readonly refreshes = new Map<string, string>();
  url = "";

  readonly #publicKey: KeyObject;
  readonly #installationTokens = new Set<string>();
  #issued = 0;
  #server = createServer((req, res) => void this.#handle(req, res));

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.#publicKey = publicKey;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as { port: number }).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #jwtValid(header: string | undefined): boolean {
    const token = header?.replace(/^Bearer /, "") ?? "";
    const [head, body, signature] = token.split(".");
    if (!head || !body || !signature) return false;
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      this.#publicKey,
      Buffer.from(signature, "base64url"),
    );
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      iss: string;
      exp: number;
    };
    return ok && claims.iss === this.appId && claims.exp * 1000 > Date.now();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    this.requests.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const form = Object.fromEntries(
      req.headers["content-type"]?.includes("json")
        ? Object.entries(text ? (JSON.parse(text) as Record<string, string>) : {})
        : new URLSearchParams(text),
    ) as Record<string, string>;
    const auth = req.headers.authorization;
    let match: RegExpExecArray | null;

    if ((match = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname))) {
      return this.#jwtValid(auth) ? send(200, { id: 7 }) : send(401);
    }
    if (url.pathname === "/app/installations/7/access_tokens" && req.method === "POST") {
      if (!this.#jwtValid(auth)) return send(401);
      const token = `ghs_installation_${++this.#issued}`;
      this.#installationTokens.add(token);
      return send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname))) {
      const token = auth?.replace(/^(Bearer|token) /, "") ?? "";
      if (!this.#installationTokens.has(token)) return send(401);
      const page = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const all = (this.pulls.get(match[1]!) ?? []).map((p) => ({
        number: p.number,
        html_url: `https://github.com/${match![1]}/pull/${p.number}`,
        head: { ref: p.head, repo: { full_name: p.headRepo ?? match![1] } },
      }));
      return send(200, all.slice((page - 1) * perPage, page * perPage));
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname))) {
      const token = auth?.replace(/^(Bearer|token) /, "") ?? "";
      if (this.rateLimited.has(token)) {
        res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0" });
        return void res.end(JSON.stringify({ message: "API rate limit exceeded" }));
      }
      const readable = this.users.get(token);
      if (!readable) return send(401, { message: "Bad credentials" });
      return readable.has(match[1]!) ? send(200, { full_name: match[1] }) : send(404);
    }
    if (url.pathname === "/login/device/code" && req.method === "POST") {
      if (form.client_id !== this.clientId) return send(401);
      return send(200, {
        device_code: `device-${++this.#issued}`,
        user_code: "ABCD-1234",
        verification_uri: `${this.url}/login/device`,
        expires_in: 900,
        interval: 0,
      });
    }
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      if (form.grant_type === "refresh_token") {
        if (form.client_secret !== this.clientSecret)
          return send(200, { error: "incorrect_client_credentials" });
        // GitHub rotates refresh tokens: each one works once.
        const token = this.refreshes.get(form.refresh_token ?? "");
        this.refreshes.delete(form.refresh_token ?? "");
        return token
          ? send(200, { access_token: token, refresh_token: `r-${token}`, expires_in: 28_800 })
          : send(200, { error: "bad_refresh_token" });
      }
      const code = form.device_code ?? "";
      if (this.deviceError) return send(200, { error: this.deviceError });
      if (this.autoApprove && !this.approved.has(code)) {
        this.approved.set(code, this.autoApprove);
        return send(200, { error: "authorization_pending" });
      }
      const token = this.approved.get(code);
      return token
        ? send(200, { access_token: token, refresh_token: `r-${token}`, expires_in: 28_800 })
        : send(200, { error: "authorization_pending" });
    }
    send(404);
  }
}
