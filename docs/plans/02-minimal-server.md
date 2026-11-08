# Plan 02 — Minimal server

Step 2 of the build order: the server that accepts heartbeats, answers warning queries, and pushes collision events, backed by the Postgres heartbeat log (ADR 0002). No auth, no mirror, no pushed or parked work yet — those are plan 04. Test-first throughout.

## The contract (`packages/core`)

oRPC contract-first: Zod schemas and an `oc` contract live in core, so the server implements it and every client (dashboard, daemon, MCP) is typed from the same source.

- `heartbeat` — `POST /api/v1/heartbeat`. Body per PRD §5.1, with each file as `{ path, whole_file, changes: [{ range, digest }], intent }`. Validation: ranges per §3.1, `ttl_seconds` 5–300 (default 60), `intent` ≤ 280 chars, ≤ 50 changes per file, ≤ 200 files. Returns the warnings for the submitted changes.
- `warnings` — `GET /api/v1/warnings`. Read-only check for one path and set of changes.
- `subscribe` — `GET /api/v1/subscribe?repo&working_copy_id`, an SSE event iterator of `collision_started` / `collision_ended`.

## The live index (`apps/server`, pure)

In-memory, clock injected, no I/O — unit-tested without a database.

- Entries keyed by **(repo, working copy, actor, path)**, indexed by (repo, path) for queries.
- `apply(heartbeat, at)`: partial replaces the listed files; complete also clears that actor's unlisted files; empty `changes` without `whole_file` clears a file.
- `warnings(query, now)`: peers in the same repo and path, excluding the caller's working copy and expired entries; one warning per peer entry, its most severe pair (core `collide`); `approximate` when base SHAs differ (no translation until the mirror exists).
- `expire(now)` every 5 s, and every read ignores expired entries, so expiry is exact.
- **Collision tracking**: after any change to (repo, path), recompute the collisions of each working copy present there and diff against the last result, emitting `collision_started` / `collision_ended` per working copy.

## The heartbeat log (`apps/server`, Postgres)

- `heartbeats` partitioned by day on `received_at`; the full validated heartbeat stored as `jsonb`. One hand-written SQL migration.
- `append(heartbeat)` inserts and `pg_notify`s in one transaction, then acknowledges.
- On startup, replay the last 300 s in id order through `apply` with each row's `received_at`, then expire against now.
- Partition maintenance on startup and hourly: create today plus 3 days ahead, drop partitions older than 3 days.
- `LISTEN/NOTIFY`: every instance applies heartbeats appended by other instances (the payload names the origin instance, so an instance skips its own).
- Presence: when a working copy's SSE stream closes and does not reconnect within 10 s, the server appends a complete, empty heartbeat for each of that working copy's actors, so the clear is durable and replicated like any other heartbeat.

Tests run against a real Postgres started by Testcontainers.

## HTTP

Fastify with oRPC's OpenAPI handler at `/api/v1` (REST + SSE) and RPC handler at `/rpc` (typed client).

## Done when

- Unit tests for the contract, index, and tracker; integration tests over HTTP for heartbeat → warning, complete vs partial, expiry, SSE start/end events, restart rebuild, two instances on one database, and presence clearing.
- A `pnpm bench` script drives 100 working copies / 300 actors and reports p50/p99 for heartbeats and queries; p99 under 10 ms.
- `pnpm typecheck`, `lint`, `fmt --check` clean.

## What the tests and the benchmark forced

- **Complete heartbeats cleared the wrong keys.** The per-actor index holds `repo\0path` keys; the clearing loop treated them as bare paths.
- **Microseconds.** Postgres stores `received_at` to the microsecond and a JS `Date` holds milliseconds, so finding a notified row by exact timestamp never matched; rows are found by id, with the timestamp only as a window for partition pruning.
- **A server shutting down cleared its clients.** Force-closing SSE streams on shutdown started presence grace timers, so a deploy would have cleared every connected working copy. The hub ignores stream closes once stopped; the regression test was confirmed to fail without the fix.
- **Parameter properties.** Node's type stripping rejects `constructor(private readonly …)`; Vitest compiled it anyway, so only running the server under plain Node caught it.
- **Acknowledge before the log write** (ADR 0002 amendment). Postgres in Docker on a laptop measured p99 13.7 ms for a bare insert at the target load, so a durable commit per heartbeat could never meet the latency goal. Heartbeats are now applied and acknowledged at once and written behind in group commits, retried until they land, with the heartbeat carried in the NOTIFY payload when it fits.
- **The tracker compared every pair twice.** Each working copy re-scanned every entry on a path; collisions are now computed once per pair per path and seen from both sides, which cut server CPU per request by about 30 %.
- **A laptop cannot judge the latency goal.** At the benchmark's request rates a do-nothing Node HTTP server measured p99 9–16 ms on the development Mac, so the latency gate runs in CI on Linux (`.github/workflows/ci.yml`).
