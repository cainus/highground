# Plan 06 — Shipping it

Step 6 of the build order: the server becomes a program people can run. It gets an entry point configured from the environment, logs through pino (PRD §9), and ships as one Docker image with a compose file (PRD §11). Acceptance criteria 5 (stale data cleared) and 6 (restart safety) get the tests the PRD names. Test-first.

## Logging

- `packages/log` keeps today's file open and writes each line with one synchronous `write`, instead of opening the file per line. It reopens the file when the UTC day changes. A server logs on the request path, so the cost of a line matters.
- `createLogs({ dir, stdout })` returns one logger per service, `backend` and `frontend`, writing to the same daily file. With `stdout`, every line is also written to stdout, which is what a container's log driver collects.
- The server takes `log` in place of its `console.error` calls and its `onLogError`, `onMirrorError` and `frontendLog` options. Each line is one JSON object.
- Every request gets a `requestId`: the client's `x-request-id` when it is a short token, otherwise a new UUID. It is echoed in the response header and carried on every line the request logs. Unexpected 500s log the error with its stack and the `requestId`.
- Requests are not logged one line each, so logging adds nothing to the heartbeat path. Failures are logged, and so are requests slower than 1 s, at `warn`.
- Log files older than 72 h are pruned on start and hourly, as the CLI does.

## `apps/server/src/main.ts`

- `configFromEnv(env)` is a pure function that turns the environment into `ServerOptions`, validated with Zod. A missing or malformed setting stops the server with a message naming the variable.
- Secrets may come from a file named by the variable with `_FILE` appended, as Docker secrets are mounted.
- Settings:
  - `DATABASE_URL` (required).
  - `HOST` (default `0.0.0.0`) and `PORT` (default `8080`).
  - `PUBLIC_URL`, the dashboard's origin for OAuth redirects.
  - `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_API_URL` / `GITHUB_WEB_URL` for GitHub Enterprise Server.
  - `SESSION_KEY`, 32 bytes in base64.
  - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
  - `MIRROR_DIR`, `WEB_DIR`, `LOG_DIR`, `LOG_STDOUT`.
  - `HIGHGROUND_ALLOW_ALL=1`, the only way to run without a GitHub App.
- The GitHub App settings come all together or not at all, and so do the VAPID ones. A partial set is an error, not a silent fallback. So is `HIGHGROUND_ALLOW_ALL=1` alongside an App.
- An empty variable counts as unset, since compose passes an unset `${X:-}` as an empty string.
- The mirror runs only with a GitHub App, whose installation tokens it fetches with.
- `GET /healthz` answers 200 when the server can reach Postgres, and 503 otherwise.
- `SIGTERM` and `SIGINT` close the server, which writes everything still pending, then exit 0. An uncaught exception is logged at `fatal`, and the process exits 1.

## Docker

- One multi-stage `Dockerfile`:
  - The build stage installs the workspace and builds the dashboard.
  - The runtime stage is `node:26-slim` plus `git`, for the mirror. It holds a production-only install of the server and the packages it uses, run as TypeScript by Node directly.
  - Workspace packages stay symlinks into `packages/`, because Node does not strip types under `node_modules`.
  - The process runs as a non-root user, with `/data` for the mirror and logs, and a `HEALTHCHECK` on `/healthz`.
- `docker-compose.yml` runs Postgres 18 with a volume, and Highground with a `/data` volume.
  - Both containers have health checks, and Highground starts once Postgres is healthy.
  - Settings come from the environment. Nothing defaults to open: an instance without a GitHub App needs `HIGHGROUND_ALLOW_ALL=1` set by whoever runs it.
  - For local development, `docker compose up postgres` gives the database alone.
- CI builds the image, starts the compose stack, and checks `/healthz`, a heartbeat round trip, and the dashboard's page. Pushes to `main` publish `ghcr.io/cainus/highground`.

## Stale data and restarts (PRD §12, criteria 5 and 6)

- The hub depends on a heartbeat store interface rather than the Postgres class, so a test can run it on fake timers with an in-memory store.
- Fake-timer tests on the hub, at the default sweep and grace periods:
  - For each of `ttl_seconds` 5, 60 and 300, a silent peer's collision is still there just before its TTL ends. A subscriber gets `collision_ended` no later than `ttl_seconds + 5 s`.
  - A peer whose stream closes is cleared within 10 s, and not before the grace period ends.
  - A restart rebuilds unexpired work, and expired work stays gone, even when it is still in the log.
- Real-time integration tests, through processes:
  - A real `highground daemon` holding a stream is killed with `SIGKILL`. The peer's warnings disappear within 10 s.
  - The server, run from `main.ts`, is killed with `SIGKILL` after a heartbeat's flush. Started again, it warns on that heartbeat with no client re-sending.
  - `SIGTERM` exits 0.

## Done when

- The tests above pass, along with tests for the logging and configuration.
- The image builds, and the compose smoke test passes, locally and in CI.
- `pnpm typecheck`, `lint` and `fmt --check` are clean, and the latency benchmark still passes.

## What the tests forced

- **The image's own default stopped it starting.** The image sets `MIRROR_DIR=/data/mirror`, and the compose smoke test found that an open instance then refused to start: a mirror needs a GitHub App to fetch with. The mirror is now on only when both are configured. The configuration test that holds this came from the smoke test, not before it.
- **Open is never a default.** Compose passes every setting through, unset ones as empty strings, so the compose file cannot leave `HIGHGROUND_ALLOW_ALL` on by default without opening every instance started from it. It defaults to empty, and an App alongside it is refused, so an instance is never unclear about whether it is open.
- **A deleted log file must not swallow lines.** Keeping the day's file open makes each line one `write`, but a file deleted while open would take every later line with it until midnight. Each write checks the path's inode against the open file's and reopens on a mismatch: one `stat` per line, still cheaper than the `open` and `close` per line it replaced.
- **A restart must not extend a TTL.** Rebuilding replays each heartbeat at the time it was received, not the restart's, so work from 30 s before a restart with a 60 s TTL ends 30 s after it. The fake-timer test fails if the rebuild uses the restart's time. It also fails if the sweep stops, and if the grace period is doubled. Each was checked by making that change to the hub.
- **A killed daemon is cleared by presence, not by TTL.** The real-time test kills a `highground daemon` process with `SIGKILL` and measures how long its peer keeps seeing its work: 9.5 to 10.5 s, the grace period. Its heartbeats' 60 s TTL would have taken six times as long.
- **Logging stays off the heartbeat path.** No request is logged one line each. Unexpected failures are logged with their stack and request id, and so are requests over 1 s. An event stream's lifetime is not a slow request. The benchmark's p99 is unchanged: 7.6 ms for heartbeats and 7.2 ms for queries.
- **pnpm comes from its own release.** Node 25 stopped shipping corepack, so the image downloads pnpm's standalone binary at the version `package.json` pins.
