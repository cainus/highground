# Plan 05 — The dashboard

Step 5 of the build order: `apps/web` (PRD §10) and the server endpoints it needs. The pages are Radar, My work, History, Admin, and Web Push for HIGH collisions. Test-first. GitHub is replaced by the fake server from plan 04, and the push service by a local HTTP server that decrypts what it receives.

## Signing in on the web

- OAuth web flow with the instance's one GitHub App (ADR 0004), using PKCE and a `state` cookie. `GET /auth/login` redirects to GitHub, and `GET /auth/callback` exchanges the code with the client secret.
- The server keeps a session in a `sessions` table:
  - The cookie value is never stored, only its SHA-256.
  - GitHub's user and refresh tokens are encrypted with AES-256-GCM under `sessionKey` (32 bytes, from configuration).
  - The row also holds the user's GitHub id, login and verified emails (`GET /user/emails`, which needs the App's _Email addresses: read_ permission).
- The cookie is `hg_session`: `HttpOnly`, `Secure` unless the public URL is plain http, `SameSite=Lax`. Calls that change state are JSON POSTs, which a cross-site form cannot send. The server refreshes the session's GitHub token when it nears expiry.
- The authorizer takes a bearer token or a session, so every repository check is the same GitHub read-access check (401/403/503) the CLI gets. `POST /auth/logout` deletes the session.
- `me` returns login, avatar and emails. `repos` returns the tracked repositories the viewer can read.

## Radar

- `LiveIndex.radar(repo, now)` gives every file with active work. Each file lists its work (working copy, actor, author, kind, branch, PR, intent, age) and its collisions as unordered pairs: the stronger verdict of the two views, with confirmed/approximate.
- Lines are shown in one display base, so bars on the same file line up. That base is the mirror's default-branch head when known, otherwise the most common base among the file's work. Lines are translated through the oracle, and a range that can't be translated yet is marked approximate. The oracle's `onLearned` refreshes it, as for warnings.
- `radar(repo)` is a snapshot. `watchRadar(repo)` is SSE: a snapshot at once, then a fresh one, at most every 250 ms, whenever a path in the repo changes. A snapshot replaces the last, so a dropped event loses nothing.
- My work is the radar filtered on the client to work whose author is one of the viewer's emails, plus the collisions that work is in.

## History (`collision_events`)

- One row per collision episode:
  - the pair, repo and path
  - the strongest type and severity reached, the last confirmation, and whether it was approximate
  - `started_at`, `ended_at`
  - `ended_by` (`a`, `b`, or `expired`)
  - `changed_course`: an agent actor's own heartbeat ended it, as opposed to the peer moving, expiry or presence
  - `notified_at`
- A partial unique index on the open episode's pair key keeps one open row per pair.
- One instance records, holding an advisory lock (`highground.recorder`), just as one publishes pushed work. Every instance projects every heartbeat, so the leader sees everything.
- When an instance becomes leader, it reconciles open rows with the index: it closes the ones no longer colliding and opens the missing ones.
- The leader checks its lock connection on every tick and steps down if the connection is lost. MirrorService gets the same check, through one shared `Lease`.
- Rows ended more than a year ago are deleted hourly.
- `history(repo, days ≤ 365)` returns:
  - episodes per day by severity
  - the 20 hottest files
  - the 20 most-colliding actor pairs
  - for agents warned at HIGH, how often they changed course

## Web Push

- VAPID keys come from configuration, and `pushKey` serves the public key.
- Subscriptions go in `push_subscriptions`: endpoint, keys and GitHub user id. They are added and removed by `subscribePush` / `unsubscribePush` from the signed-in session.
- When the recorder sees an episode reach HIGH, it sets `notified_at` with `UPDATE … WHERE notified_at IS NULL RETURNING`, so one episode notifies once even across failovers. It then pushes to every session user whose emails include a live or parked side's author.
- The payload is repo, path, peer and severity. Clicking opens the radar at the file. A 404 or 410 from the push service deletes the subscription.
- The service worker is the dashboard's own `sw.js`, which works with no tab open.

## Admin

- `admin` returns, for the repositories the viewer can read:
  - the mirror's last fetch and error
  - whether the GitHub App can mint an installation token for the repository
  - clients that reported a degraded state in the last hour
- Clients report through `POST /client-status` (`daemon` or `mcp`, version, route, degraded reason). The table is keyed by working copy and client. The daemon reports when it recovers from an outage; the MCP server reports when it falls back to the git route, at most once a minute.
- A client that cannot reach the server cannot report. Its own log file holds that.

## Frontend logs

`POST /api/v1/logs` requires a session and accepts at most 64 KB per batch and 100 lines a minute per session. The server stamps `service: "frontend"` and the session's login, and writes through `packages/log` (PRD §9). Server-wide pino logging is step 6.

## apps/web

- React, Vite, Tailwind, and shadcn/ui components, written into the app.
- TanStack Query over `@orpc/tanstack-query`, with the RPC link to `/rpc`. `watchRadar` streams through the same client.
- React Router.
- A `sw.js` for push.
- Error capture: `window.onerror`, `unhandledrejection`, and an error boundary, batched to `/api/v1/logs` with `sendBeacon` on unload.
- The server serves the built app with an SPA fallback. In development, Vite proxies `/api`, `/rpc` and `/auth`.

## Done when

- Server tests:
  - sign-in through the fake GitHub, encrypted at rest
  - session and bearer authorization agree
  - the radar's pairs, display base and stream coalescing
  - the recorder's episodes, `changed_course`, failover and retention
  - a push received and decrypted exactly once per HIGH episode
  - admin and client status
  - log caps
- Web component tests (jsdom, Testing Library), against a stub router that implements the contract, so its shapes are checked by the type system.
- One Playwright test against a real server and the fake GitHub: sign in, see a peer's heartbeat appear on the radar without a reload.
- `pnpm typecheck`, `lint`, `fmt --check` clean; the latency benchmark still passes.

## What the tests forced

- **The recorder must not slow heartbeats.** The latency benchmark failed after the recorder was added: server CPU went from 5.9 s to 10.7 s over the run, and p99 to 15 ms. Profiling showed the collision tracker and the recorder each judging every pair on every changed path. Now the hub judges each changed path once and gives the result to both. The recorder keeps its open episodes per path, keyed by the two sides' ids, and hashes a pair key only when an episode begins. Its writes go out in one flush per 100 ms, at most four statements over `unnest` arrays, instead of one statement per event. Server CPU is now 7.6 s, and p99 is 8.2 ms for heartbeats and 7.8 ms for queries.
- **A refused write is retried, not lost.** Each flush statement is idempotent, so a failed flush puts its episodes back and the next one repeats it. The test refuses inserts with a `CHECK (false) NOT VALID` constraint, then lifts it. Closing the server writes whatever is still pending, while the lease is still held.
- **Drizzle changes the shared client.** Drizzle replaces postgres-js's serializers for date and JSON types, their arrays included, with pass-throughs. A raw query that passed a `Date` failed with a 500, and an array of timestamps reached the driver unserialized. Raw queries pass ISO strings, and arrays go as `text[]` cast in SQL.
- **Unexpected 500s were silent.** The Drizzle failure surfaced only as a status code, so every oRPC handler now logs unexpected errors as one JSON line, through an `onError` interceptor.
- **Encryption at rest is checked on the raw bytes.** `JSON.stringify` serialises Buffers before a replacer sees them, so a session store that kept tokens in the clear passed the first test. The test now searches the concatenated bytes of every column.
- **Web Push needs HTTPS.** `web-push` refuses plain-HTTP endpoints, so the fake push service runs over TLS with a certificate made for the test, and `Push` takes the HTTPS agent that trusts it.
- **Repositories are known without a mirror.** `repos` and `admin` listed nothing on an instance that does not mirror. The server now records every repository a heartbeat or a client status names.
- **Expiry is not changing course.** A working copy that goes away is cleared with an empty complete heartbeat. Only an agent's own partial heartbeat ending an episode counts as changing course.
- **A leader can lose its lease silently.** An advisory lock dies with its connection, so the `Lease` runs `SELECT 1` on every tick and steps down if the connection is gone. A new leader loads the open episodes and reconciles them with its index, closing the stale ones and opening the missing ones.
- **A log batch is cut by size, not only by count.** Fifty long error lines came to 200 KB, over the server's 64 KB limit, so the server would have rejected the whole batch. The logger now cuts batches at 60 KB, and keeps at most 500 queued lines so a runaway error loop cannot grow memory.
- **A file card is named by its heading.** The radar's file cards are `role="article"` with `aria-labelledby` on the path, so a test and a screen reader find a file by name.
