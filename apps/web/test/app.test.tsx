import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.tsx";
import {
  emptyRadar,
  RadarFeed,
  REPORTING,
  SHA,
  stubClient,
  stubState,
  work,
  type StubState,
} from "./stub.ts";

const REPO = "github.com/acme/api";

function renderApp(state: StubState, path = `/radar/${REPO}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App client={stubClient(state)} retry={false} />
    </MemoryRouter>,
  );
}

const collidingRadar = {
  repo: REPO,
  reporting: REPORTING,
  files: [
    {
      path: "src/auth.ts",
      base_sha: SHA,
      work: [
        work("a", "alice@acme.com", [[10, 20]], { intent: "convert to async" }),
        work("b", "bob@acme.com", [[15, 18]], {
          kind: "pushed",
          branch: "feature/jwt",
          actor: { type: "cli", id: "feature/jwt" },
          pr_url: "https://github.com/acme/api/pull/7",
        }),
      ],
      collisions: [
        {
          a: "a",
          b: "b",
          type: "DIRECT_OVERLAP",
          severity: "HIGH",
          confirmed: true,
          approximate: false,
        },
      ],
    },
    {
      path: "README.md",
      base_sha: SHA,
      work: [work("c", "carol@acme.com", [[1, 2]])],
      collisions: [],
    },
  ],
} as const;

describe("signing in", () => {
  it("asks a signed-out visitor to sign in with GitHub, returning to where they were", async () => {
    renderApp(stubState({ me: undefined }), `/radar/${REPO}?path=a.ts`);
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    expect(link).toHaveAttribute(
      "href",
      `/auth/login?next=${encodeURIComponent(`/radar/${REPO}?path=a.ts`)}`,
    );
  });

  it("goes straight in on an instance without sign-in", async () => {
    renderApp(stubState({ me: null }));
    expect(await screen.findByRole("heading", { name: /radar/i })).toBeInTheDocument();
  });

  it("opens the first repository the user can read", async () => {
    renderApp(stubState({ repos: ["github.com/acme/web", REPO] }), "/");
    expect(
      await screen.findByText("github.com/acme/web", { selector: "h1 *" }),
    ).toBeInTheDocument();
  });
});

describe("radar", () => {
  it("shows each file's work and its collisions, worst first, with who and why", async () => {
    const state = stubState();
    state.feeds.set(REPO, new RadarFeed(structuredClone(collidingRadar) as never));
    renderApp(state);

    const files = await screen.findAllByRole("article");
    expect(files.map((f) => within(f).getByRole("heading").textContent)).toEqual([
      "src/auth.ts",
      "README.md",
    ]);
    const auth = within(files[0]!);
    expect(auth.getByText("HIGH")).toBeInTheDocument();
    expect(auth.getByText(/confirmed by merge/i)).toBeInTheDocument();
    expect(auth.getByText("convert to async")).toBeInTheDocument();
    expect(auth.getByRole("link", { name: /#7/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/pull/7",
    );
    // Each work row names its lines, so nothing depends on reading the bar's colour.
    const rows = within(auth.getByRole("list", { name: "Work" }));
    expect(rows.getByText("lines 10–20")).toBeInTheDocument();
    expect(rows.getByText("feature/jwt")).toBeInTheDocument();
    expect(rows.getByText("pushed")).toBeInTheDocument();
    expect(
      within(auth.getByRole("list", { name: "Collisions" })).getByText(
        "alice@acme.com · feature ↔ bob@acme.com · feature/jwt",
      ),
    ).toBeInTheDocument();
  });

  it("updates live as the stream sends a new radar, without a reload", async () => {
    const state = stubState();
    const feed = new RadarFeed(emptyRadar(REPO));
    state.feeds.set(REPO, feed);
    renderApp(state);
    expect(await screen.findByText(/no one is changing anything/i)).toBeInTheDocument();

    feed.push(structuredClone(collidingRadar) as never);
    expect(await screen.findByRole("heading", { name: "src/auth.ts" })).toBeInTheDocument();
  });

  it("shows a spinner, not an empty radar, until the first radar arrives", async () => {
    const state = stubState();
    const feed = new RadarFeed(emptyRadar(REPO), { held: true });
    state.feeds.set(REPO, feed);
    renderApp(state);
    expect(await screen.findByRole("status", { name: /loading the radar/i })).toBeInTheDocument();
    expect(screen.queryByText(/no one is changing anything/i)).not.toBeInTheDocument();

    feed.push(emptyRadar(REPO));
    expect(await screen.findByText(/no one is changing anything/i)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /loading the radar/i })).not.toBeInTheDocument();
  });

  it("says when no daemon is reporting, and when one was last heard from", async () => {
    const state = stubState();
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const feed = new RadarFeed(
      emptyRadar(REPO, { working_copies: 0, last_heartbeat_at: threeHoursAgo }),
    );
    state.feeds.set(REPO, feed);
    renderApp(state);
    expect(await screen.findByText(/no daemon is reporting this repository/i)).toBeInTheDocument();
    expect(screen.getByText(/last heartbeat 3 h ago/i)).toBeInTheDocument();
    expect(screen.queryByText(/no one is changing/i)).not.toBeInTheDocument();

    feed.push(emptyRadar(REPO, { working_copies: 0, last_heartbeat_at: null }));
    expect(
      await screen.findByText(/nothing has reported here since the server started/i),
    ).toBeInTheDocument();
  });

  it("says no one is changing anything, and how many working copies report, when none has work", async () => {
    const state = stubState();
    state.feeds.set(REPO, new RadarFeed(emptyRadar(REPO, { ...REPORTING, working_copies: 3 })));
    renderApp(state);
    expect(await screen.findByText(/no one is changing anything/i)).toBeInTheDocument();
    expect(screen.getByText("3 working copies are reporting.")).toBeInTheDocument();
  });

  it("in My work, also says when no daemon is reporting", async () => {
    const state = stubState();
    state.feeds.set(REPO, new RadarFeed(emptyRadar(REPO, { ...REPORTING, working_copies: 0 })));
    renderApp(state, `/mine/${REPO}`);
    expect(await screen.findByText(/no daemon is reporting this repository/i)).toBeInTheDocument();
  });

  it("names work by its branch first, with its author and kind beside it", async () => {
    const state = stubState();
    const file = { path: "a.ts", base_sha: SHA, collisions: [] };
    state.feeds.set(
      REPO,
      new RadarFeed({
        ...emptyRadar(REPO),
        files: [
          {
            ...file,
            work: [
              work("a", "me@acme.com", [[1, 2]], { branch: "fix/one" }),
              work("b", "me@acme.com", [[5, 6]], {
                branch: "fix/two",
                actor: { type: "agent", id: "claude-1" },
              }),
              work("c", "bob@acme.com", [[8, 9]], { branch: "fix/three", kind: "parked" }),
            ],
          },
        ],
      }),
    );
    renderApp(state);
    const rows = within(await screen.findByRole("list", { name: "Work" })).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("fix/one")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("me@acme.com")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("fix/two · claude-1")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("fix/three")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("parked")).toBeInTheDocument();
  });

  it("names a collision by its branches, and by its authors only when they differ", async () => {
    const state = stubState();
    const collision = {
      type: "DIRECT_OVERLAP",
      severity: "HIGH",
      confirmed: null,
      approximate: false,
    } as const;
    state.feeds.set(
      REPO,
      new RadarFeed({
        ...emptyRadar(REPO),
        files: [
          {
            path: "mine.ts",
            base_sha: SHA,
            work: [
              work("a", "me@acme.com", [[1, 2]], { branch: "fix/one" }),
              work("b", "me@acme.com", [[1, 2]], { branch: "fix/two" }),
            ],
            collisions: [{ a: "a", b: "b", ...collision }],
          },
          {
            path: "shared.ts",
            base_sha: SHA,
            work: [
              work("c", "me@acme.com", [[1, 2]], { branch: "fix/one" }),
              work("d", "bob@acme.com", [[1, 2]], { branch: "feature" }),
            ],
            collisions: [{ a: "c", b: "d", ...collision }],
          },
        ],
      }),
    );
    renderApp(state);
    const collisions = (name: string) =>
      within(
        within(screen.getByRole("article", { name })).getByRole("list", { name: "Collisions" }),
      );
    await screen.findByRole("article", { name: "mine.ts" });
    expect(collisions("mine.ts").getByText("fix/one ↔ fix/two")).toBeInTheDocument();
    expect(
      collisions("shared.ts").getByText("me@acme.com · fix/one ↔ bob@acme.com · feature"),
    ).toBeInTheDocument();
  });

  it("says when work deletes, adds or renames the whole file, not just that it is whole", async () => {
    const state = stubState();
    state.feeds.set(
      REPO,
      new RadarFeed({
        ...emptyRadar(REPO),
        files: [
          {
            path: "docs/guide.md",
            base_sha: SHA,
            work: [
              work("a", "me@acme.com", [[27, 27]], { branch: "pd-site-config-api" }),
              work("b", "me@acme.com", [], { branch: "veripages-e2", whole_file: "deleted" }),
            ],
            collisions: [
              {
                a: "a",
                b: "b",
                type: "DIRECT_OVERLAP",
                severity: "HIGH",
                confirmed: null,
                approximate: false,
              },
            ],
          },
          {
            path: "new.md",
            base_sha: SHA,
            work: [work("c", "me@acme.com", [], { branch: "fix/one", whole_file: "added" })],
            collisions: [],
          },
          {
            path: "moved.md",
            base_sha: SHA,
            work: [work("d", "me@acme.com", [], { branch: "fix/one", whole_file: "renamed" })],
            collisions: [],
          },
        ],
      }),
    );
    renderApp(state);
    const guide = within(await screen.findByRole("article", { name: "docs/guide.md" }));
    const collisions = within(guide.getByRole("list", { name: "Collisions" }));
    expect(collisions.getByText("pd-site-config-api ↔ veripages-e2")).toBeInTheDocument();
    expect(collisions.getByText("veripages-e2 deletes this file")).toBeInTheDocument();
    expect(collisions.queryByText(/same lines/i)).not.toBeInTheDocument();
    const rows = within(guide.getByRole("list", { name: "Work" }));
    expect(rows.getByText("line 27")).toBeInTheDocument();
    expect(rows.getByText("deletes the file")).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "new.md" })).getByText("new file"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "moved.md" })).getByText("renamed to this path"),
    ).toBeInTheDocument();
  });

  it("opens at the file a notification pointed to", async () => {
    const state = stubState();
    state.feeds.set(REPO, new RadarFeed(structuredClone(collidingRadar) as never));
    renderApp(state, `/radar/${REPO}?path=README.md`);
    const readme = await screen.findByRole("article", { name: "README.md" });
    expect(readme).toHaveAttribute("aria-current", "true");
  });

  it("in My work, shows only the files with the user's own work", async () => {
    const state = stubState();
    state.feeds.set(REPO, new RadarFeed(structuredClone(collidingRadar) as never));
    renderApp(state, `/mine/${REPO}`);
    expect(await screen.findByRole("heading", { name: "src/auth.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "README.md" })).not.toBeInTheDocument();
  });
});

describe("history", () => {
  it("shows collisions per day with a table view, the hottest files, and agents' course changes", async () => {
    const state = stubState({
      history: {
        days: [
          { day: "2026-11-07", HIGH: 2, MEDIUM: 1, LOW: 0 },
          { day: "2026-11-08", HIGH: 1, MEDIUM: 0, LOW: 3 },
        ],
        files: [{ path: "src/auth.ts", collisions: 3, worst: "HIGH" }],
        pairs: [{ a: "alice@acme.com", b: "bob@acme.com", collisions: 3 }],
        agents: { warned: 4, changed_course: 3 },
      },
    });
    renderApp(state, `/history/${REPO}`);
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText(/3 of 4 agents warned at HIGH changed course/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /show as table/i }));
    const table = screen.getByRole("table", { name: /collisions per day/i });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("2026-11-08")).toBeInTheDocument();
    expect(screen.getByText("alice@acme.com")).toBeInTheDocument();
  });
});

describe("admin", () => {
  it("shows mirror and App health per repository, and the clients in trouble", async () => {
    const state = stubState({
      admin: {
        github: { configured: true },
        repos: [
          {
            repo: REPO,
            added_at: "2026-11-01T00:00:00Z",
            last_fetch_at: "2026-11-08T12:00:00Z",
            last_error: null,
            installation: "ok",
          },
          {
            repo: "github.com/acme/web",
            added_at: "2026-11-01T00:00:00Z",
            last_fetch_at: null,
            last_error: "fetch failed: 404",
            installation: "missing",
          },
        ],
        clients: [
          {
            repo: REPO,
            working_copy_id: "11111111-1111-4111-8111-111111111111",
            client: "mcp",
            version: "0.1.0",
            route: "git",
            degraded: "daemon unreachable",
            reported_at: "2026-11-08T12:00:00Z",
          },
        ],
      },
    });
    renderApp(state, "/admin");
    expect(await screen.findByText("fetch failed: 404")).toBeInTheDocument();
    expect(screen.getByText(/app not installed/i)).toBeInTheDocument();
    expect(screen.getByText("daemon unreachable")).toBeInTheDocument();
  });
});

describe("Web Push", () => {
  it("subscribes this browser when the user turns notifications on", async () => {
    const state = stubState({ pushKey: "BOr8test" });
    const subscribed: unknown[] = [];
    const subscription = {
      toJSON: () => ({
        endpoint: "https://push.example.com/abc",
        keys: { p256dh: "p256", auth: "auth" },
      }),
    };
    Object.assign(globalThis, {
      Notification: { permission: "default", requestPermission: async () => "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => ({}),
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => null,
            subscribe: async (options: unknown) => {
              subscribed.push(options);
              return subscription;
            },
          },
        }),
      },
    });
    Object.assign(globalThis, { PushManager: function PushManager() {} });
    state.feeds.set(REPO, new RadarFeed(emptyRadar(REPO)));
    renderApp(state);

    await userEvent.click(await screen.findByRole("button", { name: /notify me/i }));
    await waitFor(() =>
      expect(state.subscriptions).toEqual([
        { endpoint: "https://push.example.com/abc", keys: { p256dh: "p256", auth: "auth" } },
      ]),
    );
    expect(subscribed).toMatchObject([{ userVisibleOnly: true }]);
    expect(await screen.findByText(/notifications on/i)).toBeInTheDocument();
  });
});
