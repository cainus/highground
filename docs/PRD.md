# Highground — Product Requirements

Highground tells humans and coding agents, while they work, when someone else — on any branch, in any working copy — is changing the same lines they are about to change. It is advisory only: it never locks, never blocks, and fails open.

Vocabulary is defined in [`CONTEXT.md`](../CONTEXT.md); decisions that are hard to reverse are recorded in [`docs/adr/`](adr/).

## 1. Principles

- **Advisory, never blocking.** No locks. Every client path fails open: if Highground is unreachable, work continues and the gap is reported, not hidden.
- **All unmerged work counts.** Live work (uncommitted and unpushed on the checked-out branch), parked work (unpushed commits on other local branches), and pushed work (unmerged branches on the remote, including those of people who run no client).
- **Deterministic detection.** Interval math on base coordinates, confirmed by git's own merge where both sides are commits. No heuristic or model-based code parsing in the service.
- **Symmetric clients.** Humans, agents, and the daemon use the same contracts.

## 2. Architecture

```text
 Machine (laptop / dev container / cloud sandbox) — one per filesystem holding working copies
 ┌────────────────────────────────────────────────────────────────────────┐
 │ highground daemon ── watches every registered working copy             │
 │   · git diff -U0 <merge-base> → base-coordinate ranges                 │
 │   · git merge-tree vs pushed branches (speculative merge)              │
 │   · writes .highground/{id,daemon.json} into each working copy         │
 │ highground mcp (stdio, per agent) ── asks the daemon; falls back to    │
 │   running git itself; else fails open (degraded)                       │
 └───────────────┬────────────────────────────────────────────────────────┘
                 │ POST heartbeats · GET warnings · SSE subscription
                 ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ Highground server (Fastify + oRPC), self-hosted Docker image           │
 │   · live interval index (in memory) ◄── projection of ──┐              │
 │   · Postgres: heartbeats (day-partitioned, 3 days)  ────┘              │
 │              collision_events (1 year), push subscriptions             │
 │   · mirror clone per repo (GitHub App), fetch every 30–60 s            │
 │   · speculative merges pushed↔pushed                                   │
 │   · LISTEN/NOTIFY between instances                                    │
 └───────────────┬────────────────────────────────────────────────────────┘
                 ▼
 Dashboard (React) — radar, history, admin, "My work" + Web Push
```

## 3. Concepts

### 3.1 Coordinates

All ranges on the wire are closed intervals `[start, end]` with `1 <= start` and `end >= start - 1`, in **base coordinates**. `end = start - 1` is an **insertion point**: it covers no base line and sits between lines `end` and `start` (`[1, 0]` is the top of the file). Base coordinates are positions in the file at the **base commit** (merge-base of the branch with the repository's default branch). Clients translate from and to **working-copy coordinates**; agents and humans never see base coordinates. See ADR 0001.

### 3.2 Hunk mapping

From `git diff -U0 -M --histogram <base>` (histogram matches merge-ort), plus `git ls-files --others --exclude-standard` for untracked files:

| Change                                      | Base-coordinate range                                      |
| ------------------------------------------- | ---------------------------------------------------------- |
| Modification `-a,b +c,d`                    | `[a, a+b-1]`                                               |
| Deletion `-a,b +c,0`                        | `[a, a+b-1]`                                               |
| Pure insertion after base line `a` (`-a,0`) | the insertion point `[a+1, a]`                             |
| New or untracked file                       | whole file, `added`                                        |
| Deleted file                                | whole file, `deleted`                                      |
| Rename                                      | ranges under the base path; new path whole file, `renamed` |
| Binary file                                 | whole file, `binary`                                       |

A whole-file change collides as HIGH with anything in the same path. `whole_file` is `false` or the reason in the table, so the dashboard and a peer's warning can say that work deletes the file rather than that it covers it. A client that sends `true` gave no reason, and is read as `whole`.

Each range from a diff carries a **digest**: SHA-256 of the lines that replace it (empty for a deletion), computed on the client so no code leaves the machine. Ranges with no diff behind them, such as an agent's announced intent, carry none.

### 3.3 Identity

- **Working copy** — UUID in `.highground/id` (ADR 0005). The unit of "self": warnings are suppressed only between ranges from the same working copy.
- **Actor** — `{type: "human" | "agent" | "cli", id}` acting within a working copy.
- **Author** — the person, by git email.
- **Parked work** belongs to the repository, since every worktree of it shares its branches. A branch checked out in any worktree is live work there and never parked. Parked work reports under an id derived from the repository's id and the branch name, so it still warns against its owner's live work. The repository's id is a random UUID in the git directory its worktrees share (ADR 0005), and a daemon watching several of them has one send it.
- **Pushed work** is reported by the server from its mirror; its actor is the branch, its author the head commit's author, with PR link when one exists.

## 4. Detection

Given a candidate range `[s1, e1]` and a peer range `[s2, e2]` in the same file, after translation to a common base:

The unchanged lines between two ranges are `gap = max(s1, s2) - min(e1, e2) - 1`.

1. **DUPLICATE_CHANGE (MEDIUM)** — both ranges are identical and carry the same digest: the same base lines replaced by the same content. Git merges this cleanly, but two actors did the same work.
2. **DIRECT_OVERLAP (HIGH)** — otherwise, `gap <= 0`: shared or touching lines, including two insertions at the same point. Git cannot merge these cleanly.
3. **PROXIMITY_ALERT (MEDIUM)** — `1 <= gap <= proximity_lines` (default 15, configurable per repo).

Between two files, the most severe pair wins (DIRECT_OVERLAP > DUPLICATE_CHANGE > PROXIMITY_ALERT). These rules are checked against real `git merge` by the oracle test (§12).

Further rules:

- **Suppression** — ranges from the same working copy never warn against each other, and work never warns against the pushed copy of its own branch.
- **Dormancy** — parked or pushed work with no commit for 7 days drops one severity (HIGH→MEDIUM, MEDIUM→LOW).
- **Translation** — between differing bases, a range is mapped through `git diff -U0 baseA baseB`: lines unchanged between the bases map exactly; a range that meets a change between the bases is widened over what replaced it and the warning is marked approximate.
- **Confidence**
  - `approximate: true` when the two bases differ and either the mirror cannot yet translate between them or the range met a change between the bases.
  - `confirmed: true | false` when a speculative merge (ADR 0003) has run: true if `git merge-tree` reports a conflict, false if it merges cleanly (the warning is then downgraded to MEDIUM). Absent when no speculative merge was possible (live ↔ live).
  - Speculative merges run pushed ↔ pushed on the server's mirror. Live/parked ↔ pushed merges run in the daemon, for each collision with a pushed peer: the working tree's snapshot (or the parked head) merged with the peer's `head_sha`. The daemon reports the result in its heartbeat's `merges`, and it counts only while that head is current. Live ↔ live merges run in the daemon for two worktrees it reports of one repository: both working trees' snapshots, reported as `local_merges` by either side, and counted only while neither has changed (ADR 0006). A merge that conflicts on the path makes the pair HIGH and confirmed. A clean one lowers overlapping or duplicate lines to MEDIUM and nearby lines to LOW.

## 5. API

oRPC router defined with Zod in `packages/core`, served as REST at `/api/v1/*` with a generated OpenAPI document, and as a typed client for the dashboard. Heartbeat, warnings and subscribe require the user's GitHub token (§7).

### 5.1 `POST /api/v1/heartbeat`

```json
{
  "repo": "github.com/acme/api",
  "working_copy_id": "3f6c…",
  "actor": { "type": "agent", "id": "claude-session-91" },
  "author": "alice@acme.com",
  "branch": "feature/refactor-auth",
  "base_sha": "a1b2c3…",
  "scope": "complete",
  "files": [
    {
      "path": "src/auth/jwt.py",
      "changes": [
        { "range": [45, 62], "digest": "9f2c…" },
        { "range": [110, 115], "digest": null }
      ],
      "intent": "converting verify to async"
    }
  ],
  "ttl_seconds": 60
}
```

- A heartbeat replaces the previous changes for **(repo, working copy, actor, file)**. Empty `changes` clears a file.
- `scope: "complete"` — the batch is the actor's entire state; files it omits are cleared. `scope: "partial"` — only listed files are replaced.
- `ttl_seconds` 5–300, default 60. Limits: `intent` ≤ 280 chars, ≤ 50 ranges per file, ≤ 200 files per heartbeat.
- Optional fields: `kind` (`live` by default, or `parked`; `pushed` is refused, since only the server publishes it), `head_sha` and `last_commit_at` for parked work, and `merges: [{branch, head_sha, conflicts}]`, the daemon's speculative merges with pushed heads.
- The heartbeat is applied and acknowledged at once; the log write follows within about 5 ms, group-committed and retried until it lands (ADR 0002). The response contains the current warnings for the submitted ranges.

### 5.2 `GET /api/v1/warnings`

Query: `repo`, `path`, `start`, `end`, `working_copy_id`, `base_sha`, optional `branch`. Read-only check; the caller's own working copy, and the pushed copy of its branch, are suppressed.

### 5.3 Warning payload

```json
{
  "has_collisions": true,
  "warnings": [
    {
      "severity": "HIGH",
      "type": "DIRECT_OVERLAP",
      "your_lines": [45, 62],
      "peer": {
        "working_copy_id": "9e1d…",
        "actor": { "type": "agent", "id": "agent-worker-02" },
        "author": "bob@acme.com",
        "kind": "live",
        "branch": "feature/refactor-auth",
        "head_sha": null,
        "pr_url": null,
        "lines": [50, 75],
        "intent": "converting jwt verify to async/await",
        "last_heartbeat_seconds_ago": 4
      },
      "approximate": false,
      "confirmed": true
    }
  ]
}
```

`peer.kind` is `live`, `parked`, or `pushed`; `peer.head_sha` is set for parked and pushed peers. Line numbers are base coordinates on the wire; the daemon and MCP server translate them to working-copy coordinates before showing them.

### 5.4 `GET /api/v1/subscribe` (SSE)

- Per working copy: `collision_started` / `collision_ended` events carrying the warning payload, emitted whenever a heartbeat, a fetch or a confirmation changes the collisions with that working copy's current ranges. A pushed peer's `head_sha` tells the daemon which commit to fetch for a speculative merge.
- Per repo (dashboard, `watchRadar`): a radar snapshot at once, then a fresh one, at most every 250 ms, whenever a path in the repo changes. A snapshot replaces the last, so a dropped event loses nothing.
- Resumes with `Last-Event-ID`.
- **Presence:** if a working copy's stream closes and does not reconnect within 10 s, its live ranges are cleared immediately. TTL remains the backstop for clients without a stream.

### 5.5 `GET /api/v1/auth/github`, `POST /api/v1/auth/refresh`

The instance's GitHub App client id and GitHub URL, for the device flow; and a refresh-token exchange, so that the App's client secret stays on the server. Both answer 404 without a GitHub App.

### 5.6 `POST /api/v1/logs`

Frontend log batches (§9).

### 5.7 Dashboard

`me`, `repos` (tracked repositories the caller can read), `radar`, `history` (up to 365 days), `admin`, `pushKey`, `subscribePush` / `unsubscribePush`. Clients report degraded states through `POST /api/v1/client-status`. The dashboard calls them through the RPC endpoint at `/rpc`.

## 6. Clients

One CLI, `highground`:

- **`login [--server URL]`** — GitHub device flow with the server's App. Stores the tokens in `~/.config/highground/credentials.json` (0600), one entry per server, and refreshes them through the server shortly before they expire. `HIGHGROUND_TOKEN` overrides the stored sign-in, for containers.
- **`watch [dir]`** — registers the repository holding `dir` in `~/.config/highground/config.json`; a running daemon starts reporting it at once. The daemon follows every worktree git lists for a registered repository: a worktree added later is reported within a few seconds, and one removed, or deleted without telling git, stops being reported. Registering a repository again, by any of its worktrees, changes nothing; the file keeps one entry per repository and drops entries that lead to none.
- **`daemon`** — runs wherever git works for the working copies it watches (inside a container or on a host). Watches the worktrees of registered repositories; on save, debounced 500 ms, computes base-coordinate ranges and sends a complete heartbeat; re-sends its complete snapshot every 20 s as keepalive. Scans local branches for parked work. Runs speculative merges with the pushed heads it collides with. Never fetches the remote on its own schedule. Writes `.highground/id` and `.highground/daemon.json` (addresses + per-daemon secret) into each working copy and adds `.highground/` to `.git/info/exclude`.
- **`mcp`** — stdio MCP server, one per agent. Tools:
  - `broadcast_edit_intent(path, ranges[], intent, ttl_seconds)` — ranges in working-copy coordinates; sent as a partial heartbeat for the agent actor; returns current collisions in working-copy coordinates.
  - `check_file_radar(path, ranges[])` — read-only check.
  - `describe_work(summary)` — what the agent is working on in this working copy and why, in plain language, up to 1,000 characters. Kept in `.highground/summary.md`, which a person may also write; every heartbeat from the working copy carries it as `summary`, and the latest wins. The radar shows it beside the working copy's work, above a branch's collisions, and on hovering the branch's name in a collision, and a peer's warning carries it as `peer.summary`. An empty summary removes it. Pushed work has no agent; the title of its open pull request is its summary.
  - Repo, branch, base, and working copy are derived locally; the agent never passes them.
  - Daemon discovery order: `HIGHGROUND_DAEMON_URL` → `.highground/daemon.json` (tries `127.0.0.1`, then `host.docker.internal`) → run git directly → fail open with `{degraded: true, reason, warnings: []}`.
  - Never writes anything but protocol messages to stdout.

Human IDE extensions (VS Code first) are v2.

## 7. Auth

GitHub is the identity provider and the source of repository access (ADR 0004). Device flow for the CLI, OAuth for the dashboard, both through the instance's one GitHub App. Every heartbeat, query and subscription checks the user's GitHub read access to the repo: 401 for a missing or rejected token, 403 for no access. Answers are cached for 5 minutes, refusals for 30 seconds. The same App, installed per organization with read-only contents permission, serves the mirror and PR lookups. A server without a GitHub App must be started with an explicit authorizer. The daemon's local endpoint requires the per-daemon secret from `daemon.json`.

The dashboard signs in with the OAuth web flow and PKCE. Its session is the `hg_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on https, 30 days idle). The server stores only the cookie's SHA-256, and GitHub's tokens encrypted with AES-256-GCM under the instance's session key. A session is checked against GitHub exactly as a bearer token is, and its token is refreshed an hour before it expires, by one request at a time.

## 8. Storage

Postgres via Drizzle (ADR 0002).

- **`heartbeats`** — append-only, `PARTITION BY RANGE (received_at)`, daily partitions, hand-written migration. The server creates the next 3 days of partitions and drops partitions older than 3 days, on startup and hourly.
- **Live index** — in memory, rebuilt from the last 300 s of `heartbeats` on startup; expiry checked on read and swept every 5 s; instances sync via `LISTEN/NOTIFY`.
- **`collision_events`** — one row per collision episode: the pair, path, strongest type and severity, approximate/confirmed, start and end, which side ended it, whether an agent changed course, and when its HIGH warning was pushed. Written by one instance holding an advisory lock, in batches. Kept 1 year.
- **`sessions`** — dashboard sessions (§7).
- **`push_subscriptions`** — Web Push endpoints per GitHub user.
- **`client_status`** — the last degraded or recovered report per working copy and client.
- **`repos`** — every repository a client has reported in, with the mirror's last fetch and error when it mirrors.

## 9. Logging

- pino everywhere; every line is one JSON object with `time`, `level`, `service`, `msg`, and `requestId` where applicable.
- **Server:** one combined file per day, `logs/highground-YYYY-MM-DD.jsonl` at the repo root (`LOG_DIR` overrides), containing `service: "backend"` and `service: "frontend"` lines interleaved; also stdout in production (`LOG_STDOUT`). Every request has a `requestId`, the client's `x-request-id` when it is a short token, echoed in the response. Requests are not logged one line each: unexpected failures are, with their stack, and so are requests over 1 s.
- **Frontend:** batches to `POST /api/v1/logs`, `sendBeacon` on unload; captures `window.onerror`, `unhandledrejection`, and React error boundaries; sends `requestId` on every API call. The server stamps `service: "frontend"`, validates with Zod, and caps 64 KB per batch and 100 lines/min per session.
- **CLI:** `service: "daemon"` / `"mcp"` to `~/.local/state/highground/logs/`, same format.
- **Retention:** on startup and hourly, delete log files whose day is more than 72 h old (age-based, not count-based).

## 10. Dashboard

React + Vite + Tailwind + shadcn/ui, TanStack Query over the oRPC client, live over SSE.

- **Radar** — per repo, files with active work; ranges by working copy and actor (human, agent, pushed branch); collisions highlighted with confirmed/approximate, intent, and PR links. It also says how many working copies are reporting, counting idle ones, whose heartbeats carry no files, and when the repository was last heard from. An empty radar can then tell "no one is changing anything" from "no daemon is reporting".
- **My work** — the radar filtered to the signed-in author's working copies.
- **Web Push** — opt-in; notifies on HIGH collisions newly started against the user's working copies, once per collision; clicking opens the radar at the file. Works with no tab open. The user's working copies are those whose author is one of the user's verified GitHub emails, and a user who can no longer read the repository is not told.
- **History** — collision events over time, hottest files, most-colliding actor pairs, and how often agents changed course after a warning.
- **Admin** — repos, GitHub App status, mirror fetch health, and daemons and MCP servers that reported a degraded state in the last hour.

The server serves the built dashboard beside the API, with a content security policy that allows only its own origin and GitHub's avatars. Any page path falls back to the app; fingerprinted assets are cached for good.

## 11. Repository layout

pnpm monorepo:

```
packages/core   Zod schemas, interval math, hunk mapping, base translation — pure
packages/git    merge-base, diff -U0, merge-tree, index-copy snapshots, working-copy identity
packages/log    pino to daily JSON-lines files, pruned after 72 h
apps/server     Fastify + oRPC, live index, Postgres, mirror, GitHub App, Web Push
apps/web        dashboard
apps/cli        highground login | daemon | mcp
```

Tooling: TypeScript, Vitest, Oxfmt + Oxlint, Drizzle. Shipped as one Docker image (`ghcr.io/cainus/highground`: server + built dashboard) with a `docker-compose.yml` adding Postgres and a `/data` volume for the mirror and logs; local development uses the same compose file. The server is configured from the environment (README), reports `GET /healthz`, and stops cleanly on `SIGTERM`.

## 12. Acceptance criteria

1. **Agreement with git.** A fast-check differential test generates random base files and pairs of edits, runs a real `git merge`, and asserts DIRECT_OVERLAP ⇔ CONFLICT over thousands of cases.
2. **Interval math properties.** Symmetry, translate-and-back identity, idempotent complete heartbeats; 100 % branch coverage of `packages/core` enforced in Vitest.
3. **Latency.** A benchmark in CI, on Linux, at 100 working copies and 300 actors with requests arriving evenly keeps p99 under 10 ms for queries and heartbeats, as the client sees them. It prints a do-nothing server under the same load and the server's own timing beside that, so a miss can be placed.
4. **Never blocks.** No endpoint takes a lock a client waits on; every client failure path fails open and is logged.
5. **Stale data cleared.** A killed client's warnings disappear within `ttl_seconds + 5 s`, and within 10 s when it held an SSE stream — tested with fake timers and with one real-time integration test.
6. **Restart safety.** After a server restart, every unexpired range that reached the log is warned on again without any client re-sending; a crash loses at most the last flush, which clients restore with their next complete snapshot.
