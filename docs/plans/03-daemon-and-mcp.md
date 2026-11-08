# Plan 03 — Daemon and MCP

Step 3 of the build order: the `highground` CLI's `daemon` and `mcp` commands (PRD §6), so live work reaches the server from every working copy and agents can announce intent and check the radar. Login, parked work, pushed work and speculative merges need the GitHub App and the mirror, so they are plan 04; until then the server is unauthenticated. Test-first throughout.

## packages/core

- `repoFromRemote(url)` — `git@github.com:acme/api.git`, `https://github.com/acme/api`, `ssh://git@github.com/acme/api.git` → `github.com/acme/api`; null for anything it cannot name.
- `invertHunks(hunks)` — the hunks of `diff B A` from those of `diff A B`, so `translate` maps both ways.
- `toBase(range, hunks)` / `toWorking(range, hunks)` — one file's working-copy ↔ base mapping through `translate`, where `hunks` are that file's `diff base worktree`. A working-copy range inside the actor's own change widens to the base lines that change replaced, which is what can conflict.
- `capChanges(changes, max)` — merges the two closest neighbouring changes until at most `max` remain (digest dropped on a merge), so a file with more than 50 hunks still reports every line it touches.

## packages/git

- `repoState(dir)` — toplevel, repo (from `origin`), default ref (`origin/HEAD`, else `origin/main`, else `origin/master`), base commit, branch (`HEAD` when detached), author (`user.email`). Throws a typed `NotARepository` / `NoRemote` / `NoDefaultBranch` so callers can say why they degraded.
- `fileHunks(dir, base, path)` — the hunks of `git diff -U0 --histogram base -- path` against the working tree; null when the path is not in the base (new or untracked: whole file).
- `ensureIdentity(dir)` — creates `.highground/id` (UUID) when missing and adds `/.highground/` to the repository's `info/exclude`; returns the id.
- `findIdentity(start)` — walks up from `start` to the directory holding `.highground/id`, without git, so an MCP server in a container whose `.git` points at a host path still knows its working copy and its repo-relative paths.

## packages/log

pino, one JSON object per line with `time`, `level`, `service`, `msg`, to `highground-YYYY-MM-DD.jsonl` in a directory (CLI default `~/.local/state/highground/logs`, `HIGHGROUND_LOG_DIR` overrides), switching file at UTC midnight; files more than 72 h old are deleted on start and hourly. The server adopts it in plan 06.

## apps/cli — `highground daemon [dir…]`

- Watches each working copy given, and those listed in `~/.config/highground/config.json` (`highground watch [dir]` adds one; the running daemon re-reads the file when it changes). Server URL from `--server`, `HIGHGROUND_SERVER_URL`, or the config.
- Per working copy: `ensureIdentity`, then on any filesystem event (outside `.highground/`) debounced 500 ms, and every 20 s regardless, recompute `repoState` + `diffRanges` and send one complete heartbeat for actor `{type: "cli", id: "daemon"}`, ttl 60 s. The 20 s recompute is also the safety net for missed filesystem events on bind mounts. More than 200 files: the first 200 go complete, the rest partial, in order.
- Holds an SSE subscription per working copy (presence), reconnecting with backoff; keeps each working copy's current collisions.
- Fails open: a failed heartbeat or stream is logged with the reason and retried on the next tick; the daemon never exits because the server is down.
- Local endpoint: oRPC over HTTP on `127.0.0.1` (`--listen` to change, for containers on Linux reaching a host daemon). Every request needs the per-daemon secret. Procedures `intent` and `check`, taking a working copy id, an actor, a repo-relative path and working-copy ranges; the daemon translates with its cached hunks and forwards.
- Writes `.highground/daemon.json` (`port`, `addresses: ["127.0.0.1", "host.docker.internal"]`, `secret`, `server`, `pid`, mode 0600) into each working copy; removes it on clean shutdown.

## apps/cli — `highground mcp`

- stdio MCP server; nothing but protocol messages on stdout, logs to file.
- Tools `broadcast_edit_intent(path, ranges, intent, ttl_seconds)` and `check_file_radar(path, ranges)`; ranges are `[start, end]` in working-copy lines. Repo, branch, base and working copy are derived locally. The actor is `{type: "agent", id: "<client name>-<random>"}`, fixed for the process.
- Route, in order: `HIGHGROUND_DAEMON_URL` → `.highground/daemon.json` addresses → git run by the MCP server itself against the server URL from `HIGHGROUND_SERVER_URL` or `daemon.json` → `{degraded: true, reason, warnings: []}`. Every degradation is logged.
- Results carry warnings with `your_lines` and `peer.lines` in working-copy lines, and which route answered.

## Done when

- Unit tests for the core additions at 100 % branch coverage; git tests against throwaway repos; log tests with an injected clock.
- Integration tests against a real server: an edit reaches the server within the debounce and a reverted edit clears it; the 20 s keepalive; a daemon started with the server down recovers when it comes up; the local endpoint rejects a wrong secret; intent and check over the daemon, over direct git, and degraded; working-copy coordinates on the way in and out; a spawned `highground mcp` writes only JSON-RPC to stdout.
- `pnpm typecheck`, `lint`, `fmt --check` clean.

## What the tests forced

- **Stopping hung on the collision stream.** oRPC's client event iterator does not always end when its abort signal fires while it waits for the next event, so `stop()` waited forever whenever no collision had arrived — and an open stream would also have kept the server believing the working copy was present. Each read now races the stop, and the iterator is returned, which closes the stream; a test checks that a stopped reporter's work leaves the server within the presence grace period, not the 60 s TTL.
- **`/var` is `/private/var`.** On macOS the agent's working directory and git's top-level differ by a symlink, so every path looked outside the working copy. The MCP server resolves its working directory, and each path's directory, through symlinks before relating them; the file itself may not exist yet.
- **A container sees the worktree at another path, without git.** The daemon route takes repo-relative paths and the working copy id, so an MCP server that finds `.highground/` by walking up — in a copy of the working copy with no `.git` — is answered by the host's daemon in its own coordinates.
