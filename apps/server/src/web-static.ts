import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

/** Paths the dashboard never owns: their misses stay 404s instead of becoming the app. */
const NOT_THE_APP = /^\/(?:api|rpc|auth|assets)(?:\/|$)/;

/**
 * The dashboard's policy: everything from this origin, images also from GitHub's
 * avatars (github.com's avatar host, or a GitHub Enterprise server's own host), and no
 * framing. React sets styles through the CSSOM, which `style-src` does not govern.
 */
function contentSecurityPolicy(githubWebUrl: string): string {
  const avatars =
    new URL(githubWebUrl).hostname === "github.com"
      ? "https://avatars.githubusercontent.com"
      : new URL(githubWebUrl).origin;
  return [
    "default-src 'self'",
    `img-src 'self' data: ${avatars}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Serves the built dashboard from `dir`: Vite's fingerprinted `assets/` cached for good,
 * everything else (`index.html`, `sw.js`) revalidated every time so a deploy is seen at
 * once, and any GET for an HTML page that matches nothing answered with the app, so deep
 * links and reloads land on the right page.
 */
export async function registerWebStatic(
  app: FastifyInstance,
  { dir, githubWebUrl }: { dir: string; githubWebUrl: string },
): Promise<void> {
  const policy = contentSecurityPolicy(githubWebUrl);
  const secure = (reply: FastifyReply) =>
    reply
      .header("content-security-policy", policy)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "same-origin");
  await app.register(fastifyStatic, {
    root: dir,
    cacheControl: false,
    setHeaders: (reply, path) => {
      secure(reply).header(
        "cache-control",
        path.startsWith(join(dir, "assets")) ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    const page =
      (request.method === "GET" || request.method === "HEAD") &&
      !NOT_THE_APP.test(path) &&
      (request.headers.accept ?? "").includes("text/html");
    if (!page) return reply.code(404).send({ error: "not found" });
    return secure(reply).header("cache-control", "no-cache").sendFile("index.html");
  });
}
