import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubApp } from "../src/github.ts";
import { FakeGitHub } from "./fake-github.ts";

let gh: FakeGitHub;
const app = () =>
  new GitHubApp({
    appId: gh.appId,
    privateKey: gh.privateKey,
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    apiUrl: gh.url,
    webUrl: gh.url,
  });

beforeAll(async () => {
  gh = await new FakeGitHub().start();
});
afterAll(async () => {
  await gh.stop();
});

describe("GitHubApp", () => {
  it("mints an installation token with a signed JWT and reuses it until near expiry", async () => {
    const github = app();
    const first = await github.installationToken("github.com/acme/api");
    expect(first).toMatch(/^ghs_installation_/);
    expect(await github.installationToken("github.com/acme/api")).toBe(first);
    expect(gh.requests.filter((r) => r.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("gives git the token as a basic-auth header, through config rather than the URL", async () => {
    const config = await app().gitConfig("github.com/acme/api");
    const header = config["http.extraHeader"]!;
    const decoded = Buffer.from(header.replace("Authorization: Basic ", ""), "base64").toString();
    expect(decoded).toMatch(/^x-access-token:ghs_installation_/);
    expect(app().remoteUrl("github.com/acme/api")).toBe("https://github.com/acme/api.git");
  });

  it("maps open pull requests from the repository's own branches, across pages", async () => {
    gh.pulls.set("acme/api", [
      ...Array.from({ length: 120 }, (_, i) => ({ head: `b${i}`, number: i + 1 })),
      { head: "main", headRepo: "someone/fork", number: 500 },
    ]);
    const pulls = await app().openPullRequests("github.com/acme/api");
    expect(pulls.size).toBe(120);
    expect(pulls.get("b119")).toEqual({
      url: "https://github.com/acme/api/pull/120",
      title: "Pull request 120",
    });
    expect(pulls.has("main")).toBe(false);
  });

  it("checks a user's read access with their own token", async () => {
    gh.users.set("ghu_alice", new Set(["acme/api"]));
    const github = app();
    expect(await github.access("ghu_alice", "github.com/acme/api")).toBe("read");
    expect(await github.access("ghu_alice", "github.com/acme/secret")).toBe("denied");
    expect(await github.access("ghu_nobody", "github.com/acme/api")).toBe("invalid");
  });

  it("treats a spent rate limit as GitHub failing, not as the user lacking access", async () => {
    gh.rateLimited.add("ghu_busy");
    await expect(app().access("ghu_busy", "github.com/acme/api")).rejects.toThrow(/403/);
  });

  it("refreshes a user's token with the App's client secret", async () => {
    gh.refreshes.set("r-old", "ghu_new");
    expect(await app().refresh("r-old")).toMatchObject({ access_token: "ghu_new" });
    await expect(app().refresh("r-unknown")).rejects.toThrow(/bad_refresh_token/);
  });
});
