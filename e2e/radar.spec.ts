import { expect, test } from "@playwright/test";

const REPO = "github.com/acme/api";
const SHA = "a".repeat(40);
const BOB = "22222222-2222-4222-8222-222222222222";

/** Bob's daemon reports work through the public API, as the CLI does. */
async function bobChanges(baseURL: string, path: string, lines: [number, number]) {
  const res = await fetch(`${baseURL}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ghu_bob" },
    body: JSON.stringify({
      repo: REPO,
      working_copy_id: BOB,
      actor: { type: "cli", id: "daemon" },
      author: "bob@acme.dev",
      branch: "feature/jwt",
      base_sha: SHA,
      scope: "partial",
      files: [{ path, changes: [{ range: lines, digest: null }] }],
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

test("a signed-in user sees a peer's work appear on the radar without reloading", async ({
  page,
  baseURL,
}) => {
  // The repository is tracked once anyone reports in it.
  await bobChanges(baseURL!, "README.md", [1, 3]);

  await page.goto(`/radar/${REPO}`);
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  // Back from GitHub at the page we asked for, signed in.
  await expect(page).toHaveURL(new RegExp(`/radar/${REPO}$`));
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("article", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("article", { name: "src/auth.ts" })).toHaveCount(0);

  const loads: string[] = [];
  page.on("framenavigated", (frame) => frame === page.mainFrame() && loads.push(frame.url()));

  await bobChanges(baseURL!, "src/auth.ts", [10, 20]);

  const card = page.getByRole("article", { name: "src/auth.ts" });
  await expect(card).toBeVisible();
  await expect(card.getByText("bob@acme.dev").first()).toBeVisible();
  expect(loads).toEqual([]);
});
