import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GitHubApp } from "./github.ts";
import type { Sessions } from "./sessions.ts";

export const SESSION_COOKIE = "hg_session";
const OAUTH_COOKIE = "hg_oauth";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const OAUTH_MAX_AGE_S = 600;

/** `name=value; …` → name → value. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0)
      cookies.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return cookies;
}

interface CookieOptions {
  path: string;
  maxAge: number;
  secure: boolean;
}

function cookie(name: string, value: string, { path, maxAge, secure }: CookieOptions): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A path on this site to return to after signing in; anything else is ignored. */
const localPath = (next: unknown) =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")
    ? next
    : "/";

export interface WebAuthOptions {
  github: GitHubApp;
  sessions: Sessions;
  /** The dashboard's public origin; the request's own origin when unset. */
  publicUrl?: string | undefined;
}

/**
 * The dashboard's sign-in (plan 05): GitHub's web flow with PKCE through the instance's
 * App, a `state` checked against a short-lived cookie, and a session cookie that
 * scripts cannot read.
 */
export function registerWebAuth(app: FastifyInstance, options: WebAuthOptions): void {
  const origin = (request: FastifyRequest) =>
    (options.publicUrl ?? `${request.protocol}://${request.host}`).replace(/\/+$/, "");
  const secure = (request: FastifyRequest) => origin(request).startsWith("https:");

  app.get("/auth/login", async (request, reply) => {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const next = localPath((request.query as { next?: unknown }).next);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return reply
      .header(
        "set-cookie",
        cookie(OAUTH_COOKIE, JSON.stringify({ state, verifier, next }), {
          path: "/auth",
          maxAge: OAUTH_MAX_AGE_S,
          secure: secure(request),
        }),
      )
      .redirect(
        options.github.authorizeUrl({
          state,
          challenge,
          redirectUri: `${origin(request)}/auth/callback`,
        }),
      );
  });

  app.get("/auth/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    let pending: { state: string; verifier: string; next: string } | undefined;
    try {
      pending = JSON.parse(parseCookies(request.headers.cookie).get(OAUTH_COOKIE) ?? "null");
    } catch {
      pending = undefined;
    }
    const clear = cookie(OAUTH_COOKIE, "", { path: "/auth", maxAge: 0, secure: secure(request) });
    if (!code || !state || !pending || !same(state, pending.state)) {
      return reply
        .header("set-cookie", clear)
        .code(400)
        .send({ error: "sign-in expired; try again" });
    }
    const tokens = await options.github.exchangeCode(
      code,
      pending.verifier,
      `${origin(request)}/auth/callback`,
    );
    const [user, emails] = await Promise.all([
      options.github.user(tokens.access_token),
      options.github.emails(tokens.access_token),
    ]);
    const value = await options.sessions.create(tokens, user, emails);
    return reply
      .header("set-cookie", [
        clear,
        cookie(SESSION_COOKIE, value, {
          path: "/",
          maxAge: SESSION_MAX_AGE_S,
          secure: secure(request),
        }),
      ])
      .redirect(localPath(pending.next));
  });

  app.post("/auth/logout", async (request, reply: FastifyReply) => {
    const value = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (value) await options.sessions.delete(value);
    return reply
      .header(
        "set-cookie",
        cookie(SESSION_COOKIE, "", { path: "/", maxAge: 0, secure: secure(request) }),
      )
      .code(204)
      .send();
  });
}
