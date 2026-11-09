import {
  contract,
  type Admin,
  type History,
  type Me,
  type PushSubscription,
  type Radar,
  type Reporting,
} from "@highground/core";
import type { ContractRouterClient } from "@orpc/contract";
import { createRouterClient, implement, ORPCError } from "@orpc/server";

/** One daemon reporting, just now: what a radar says unless a test says otherwise. */
export const REPORTING: Reporting = {
  working_copies: 1,
  last_heartbeat_at: new Date().toISOString(),
};

/** A radar with no work in flight. */
export const emptyRadar = (repo: string, reporting: Reporting = REPORTING): Radar => ({
  repo,
  files: [],
  reporting,
});

/** A radar stream the test feeds, one snapshot at a time. */
export class RadarFeed {
  readonly #waiting: ((radar: Radar) => void)[] = [];
  readonly #queued: Radar[] = [];
  current: Radar;
  /** Sends nothing until the first `push`, as a server still working out the first radar. */
  readonly held: boolean;
  constructor(current: Radar, { held = false } = {}) {
    this.current = current;
    this.held = held;
  }
  push(radar: Radar): void {
    this.current = radar;
    const wake = this.#waiting.shift();
    if (wake) wake(radar);
    else this.#queued.push(radar);
  }
  async next(): Promise<Radar> {
    return this.#queued.shift() ?? new Promise((resolve) => this.#waiting.push(resolve));
  }
}

/** What the stub server answers; each test sets what it needs. */
export interface StubState {
  /** `undefined`: signed out; `null`: an open instance with no sign-in. */
  me: Me | null | undefined;
  repos: string[];
  feeds: Map<string, RadarFeed>;
  history?: History;
  admin?: Admin;
  pushKey?: string;
  subscriptions: PushSubscription[];
  logs: unknown[];
}

export function stubState(overrides: Partial<StubState> = {}): StubState {
  return {
    me: { login: "alice", avatar_url: "https://example.com/a.png", emails: ["alice@acme.com"] },
    repos: ["github.com/acme/api"],
    feeds: new Map(),
    subscriptions: [],
    logs: [],
    ...overrides,
  };
}

/** A client over a router that implements the real contract, so shapes are type-checked. */
export function stubClient(state: StubState): ContractRouterClient<typeof contract> {
  const os = implement(contract);
  const feed = (repo: string) => {
    let f = state.feeds.get(repo);
    if (!f) state.feeds.set(repo, (f = new RadarFeed(emptyRadar(repo))));
    return f;
  };
  const signedIn = () => {
    if (state.me === undefined) throw new ORPCError("UNAUTHORIZED", { message: "sign in" });
  };
  const missing = () => new ORPCError("NOT_FOUND", { message: "not here" });
  const router = os.router({
    heartbeat: os.heartbeat.handler(() => ({ has_collisions: false, warnings: [] })),
    warnings: os.warnings.handler(() => ({ has_collisions: false, warnings: [] })),
    subscribe: os.subscribe.handler(async function* () {}),
    radar: os.radar.handler(({ input }) => feed(input.repo).current),
    watchRadar: os.watchRadar.handler(async function* ({ input, signal }) {
      const f = feed(input.repo);
      if (!f.held) yield f.current;
      while (!signal?.aborted) yield await f.next();
    }),
    history: os.history.handler(() => {
      if (!state.history) throw missing();
      return state.history;
    }),
    admin: os.admin.handler(() => {
      if (!state.admin) throw missing();
      return state.admin;
    }),
    clientStatus: os.clientStatus.handler(() => ({})),
    logs: os.logs.handler(({ input }) => {
      state.logs.push(...input.lines);
      return { accepted: input.lines.length };
    }),
    pushKey: os.pushKey.handler(() => {
      if (!state.pushKey) throw missing();
      return { public_key: state.pushKey };
    }),
    subscribePush: os.subscribePush.handler(({ input }) => {
      signedIn();
      state.subscriptions.push(input);
      return {};
    }),
    unsubscribePush: os.unsubscribePush.handler(({ input }) => {
      state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== input.endpoint);
      return {};
    }),
    me: os.me.handler(() => {
      if (state.me === null) throw missing();
      signedIn();
      return state.me!;
    }),
    repos: os.repos.handler(() => {
      signedIn();
      return { repos: state.repos };
    }),
    authConfig: os.authConfig.handler(() => {
      throw missing();
    }),
    refresh: os.refresh.handler(() => {
      throw missing();
    }),
  });
  return createRouterClient(router);
}

const SHA = "a".repeat(40);

/** One actor's work on a file, with defaults. */
export function work(
  id: string,
  author: string,
  lines: [number, number][],
  extra: Partial<Radar["files"][number]["work"][number]> = {},
): Radar["files"][number]["work"][number] {
  return {
    id,
    working_copy_id: "11111111-1111-4111-8111-111111111111",
    actor: { type: "cli", id: "daemon" },
    author,
    kind: "live",
    branch: "feature",
    head_sha: null,
    pr_url: null,
    base_sha: SHA,
    whole_file: false,
    lines,
    approximate: false,
    intent: null,
    last_heartbeat_seconds_ago: 3,
    ...extra,
  };
}

export { SHA };
