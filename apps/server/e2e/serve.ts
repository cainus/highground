// The end-to-end harness: Postgres in a container, the fake GitHub, and the real server
// serving the built dashboard on E2E_PORT. Playwright starts it and stops it with SIGTERM.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "../src/db/migrate.ts";
import { startServer } from "../src/server.ts";
import { FakeGitHub } from "../test/fake-github.ts";

const port = Number(process.env.E2E_PORT ?? 4319);
const origin = `http://127.0.0.1:${port}`;

const container = await new PostgreSqlContainer("postgres:18-alpine").start();
const databaseUrl = container.getConnectionUri();
await migrate(databaseUrl);

const gh = await new FakeGitHub().start();
// Alice signs in on the web; Bob is the peer whose daemon reports.
gh.users.set("ghu_alice", new Set(["acme/api"]));
gh.users.set("ghu_bob", new Set(["acme/api"]));
gh.profiles.set("ghu_alice", {
  id: 1,
  login: "alice",
  emails: [{ email: "alice@acme.dev", verified: true }],
});
gh.webUser = "ghu_alice";

const server = await startServer({
  databaseUrl,
  port,
  sessionKey: randomBytes(32),
  publicUrl: origin,
  webDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  radarMs: 50,
  github: {
    appId: gh.appId,
    privateKey: gh.privateKey,
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    apiUrl: gh.url,
    webUrl: gh.url,
  },
});
console.log(`highground e2e server at ${server.url}`);

const stop = async () => {
  await server.close();
  await gh.stop();
  await container.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
