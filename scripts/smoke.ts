/**
 * Checks a running instance from outside, as an operator would after `docker compose up`:
 * healthy, a heartbeat round trip between two working copies, and the dashboard served.
 *
 *   node scripts/smoke.ts http://localhost:8080
 *
 * The instance must run open (HIGHGROUND_ALLOW_ALL=1). Exits 1 on the first failure.
 */
const base = process.argv[2] ?? "http://localhost:8080";
const REPO = "github.com/acme/smoke";
const SHA = "a".repeat(40);
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.log(`ok  ${what}`);
}

async function healthy(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/healthz`).catch(() => undefined);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

check(await healthy(Date.now() + 60_000), "/healthz answers 200");

const sent = await fetch(`${base}/api/v1/heartbeat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    repo: REPO,
    working_copy_id: BOB,
    actor: { type: "cli", id: "daemon" },
    author: "bob@acme.dev",
    branch: "feature",
    base_sha: SHA,
    scope: "partial",
    files: [{ path: "a.ts", changes: [{ range: [10, 20], digest: null }] }],
  }),
});
check(sent.ok, `a heartbeat is accepted (${sent.status})`);

const params = new URLSearchParams({
  repo: REPO,
  path: "a.ts",
  start: "15",
  end: "15",
  working_copy_id: ALICE,
  base_sha: SHA,
});
const answer = (await (await fetch(`${base}/api/v1/warnings?${params}`)).json()) as {
  has_collisions: boolean;
};
check(answer.has_collisions, "another working copy is warned about it");

const page = await fetch(`${base}/radar/${REPO}`, { headers: { accept: "text/html" } });
const html = await page.text();
check(page.ok && html.includes('<div id="root">'), "a dashboard deep link serves the app");
check(
  (page.headers.get("content-security-policy") ?? "").includes("default-src 'self'"),
  "the dashboard has its content security policy",
);
