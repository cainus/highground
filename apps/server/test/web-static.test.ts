import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let s: RunningServer;
const webDir = mkdtempSync(join(tmpdir(), "highground-web-"));

beforeAll(async () => {
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Highground</title>");
  writeFileSync(join(webDir, "sw.js"), "self.addEventListener('push', () => {});");
  writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log(1)");
  db = await freshDatabase();
  s = await startServer({ databaseUrl: db.url, port: 0, auth: allowAll, webDir });
});
afterAll(async () => {
  await s.close();
  await db.close();
  rmSync(webDir, { recursive: true, force: true });
});

const get = (path: string, accept = "text/html") =>
  fetch(`${s.url}${path}`, { headers: { accept } });

describe("serving the dashboard", () => {
  it("serves the app at the root, never cached, with a content security policy", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Highground</title>");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers any client-side route with the app, so deep links and reloads work", async () => {
    for (const path of [
      "/radar/github.com/acme/api",
      "/history/github.com/acme/api?days=7",
      "/admin",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("<title>Highground</title>");
    }
  });

  it("caches fingerprinted assets for good, and the service worker not at all", async () => {
    const asset = await get("/assets/index-abc123.js", "*/*");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const sw = await get("/sw.js", "*/*");
    expect(sw.status).toBe(200);
    expect(sw.headers.get("cache-control")).toBe("no-cache");
  });

  it("keeps the API's 404s, and a missing asset's, as 404s rather than the app", async () => {
    expect((await get("/api/v1/nope", "application/json")).status).toBe(404);
    expect((await get("/rpc/nope", "application/json")).status).toBe(404);
    expect((await get("/auth/nope")).status).toBe(404);
    expect((await get("/assets/missing.js", "*/*")).status).toBe(404);
    expect((await fetch(`${s.url}/radar/x`, { method: "POST" })).status).toBe(404);
  });

  it("still answers the API beside the app", async () => {
    const res = await get("/api/v1/radar?repo=github.com/acme/api", "application/json");
    expect(res.status).toBe(200);
  });
});
