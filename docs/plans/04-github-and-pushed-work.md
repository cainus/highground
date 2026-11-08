# Plan 04 — GitHub, the mirror, and all unmerged work

Step 4 of the build order: pushed and parked work join live work, warnings between differing bases are translated, speculative merges confirm or refute them (ADR 0003), and every request is authorized against GitHub (ADR 0004). Test-first; GitHub itself is replaced in tests by a fake HTTP server and local bare repositories.

## Heartbeats carry what they describe

- `kind`: `live` (default), `parked` or `pushed`. Clients may send `live` and `parked`; only the server publishes `pushed`.
- `head_sha` and `last_commit_at` for parked and pushed work: the commit a speculative merge uses, and the age that dormancy (7 days without a commit drops one severity) is measured from.
- `pr_url` for pushed work.
- `merges`: the daemon's speculative-merge results for its live or parked work, `[{ branch, head_sha, conflicts: [paths] }]`, re-sent with every complete heartbeat. Carried in the heartbeat, they reach every instance through the log and survive restarts like everything else.
- Warnings carry `peer.head_sha`, so a daemon that sees a collision with pushed work knows which commit to merge with. This replaces the separate `branch_updated` event in PRD §5.4.

## The live index learns from the mirror

`LiveIndex` stays pure and synchronous; it takes an oracle with two lookups that answer from a cache or report "not yet":

- `hunks(repo, fromBase, toBase, path)` — for translating a peer's ranges into the viewer's base. Unknown, or a range that meets a change between the bases, marks the warning approximate.
- `conflicts(repo, headA, headB)` — the paths a speculative merge of two pushed heads conflicts on.

A miss queues the git work; when it lands, the oracle names the paths to refresh and the collision tracker re-emits. Confirmation: a pair between pushed work, or between live/parked work and pushed work the daemon has merged with (matching `merges` entry), gets `confirmed: true` when the merge conflicts on the path, and `confirmed: false` with severity dropped to MEDIUM when it is clean. Proximity alerts are never confirmed.

Further rules:

- Work never warns against the pushed copy of its own branch (same branch name, one side pushed).
- Parked work reports under a working copy id derived from the working copy and branch, so it warns against its owner's own live work.

## The mirror (`apps/server`)

- One bare clone per repository under `MIRROR_DIR`, fetching `refs/heads/*` every 45 s and on demand when a heartbeat names a base the mirror lacks. Each instance keeps its own mirror, so translation and merges are local; one instance at a time (Postgres advisory lock) publishes pushed work.
- Credentials: a GitHub App installation token per repository, minted from the App's private key and cached until near expiry, passed to git through `GIT_CONFIG_*` environment variables, never argv.
- A `repos` table lists mirrored repositories, with the last fetch and its error; a repository is added the first time an authorized heartbeat names it.
- Pushed work: after each fetch, every branch other than the default with commits not on it becomes a complete `pushed` heartbeat (its diff from the merge-base, through the same hunk mapping as live work), with the head commit's author and date and the open PR's URL (GitHub API, same-repository heads). Branches that vanish or merge are cleared. Unchanged branches are not re-diffed.

## Parked work and merges in the daemon (`apps/cli`)

- Every local branch other than the checked-out one with commits on neither the default branch nor its own upstream is sent as `parked` work.
- For each collision with pushed work that is a direct overlap or duplicate, the daemon merges a snapshot of the working tree (or the parked branch's head) with the peer's head — fetching only that commit, only on the server's prompt — and reports the result in `merges`. Debounced, cached by (own commit, peer head).

## Authorization

- One GitHub App per instance serves both the mirror and sign-in (amends ADR 0004, which had a separate OAuth app).
- `highground login`: GitHub device flow with the App's client id, fetched from the server; the user token is stored in `~/.config/highground/credentials.json` (0600) per server. Refresh goes through the server, which holds the client secret.
- Every heartbeat, query and subscription carries the token; the server checks read access with `GET /repos/{owner}/{name}`, cached 5 minutes (30 s when denied). Daemon and MCP send it; `HIGHGROUND_TOKEN` overrides for containers.
- `startServer` takes an authorizer; tests and local development pass an allow-all one explicitly.

## Done when

- Unit tests for the index's translation, confirmation, dormancy and suppression rules with a fake oracle.
- Integration tests with a local bare "GitHub" remote and a fake GitHub API: a pushed branch warns a live working copy; a merged or deleted branch stops warning; translation across differing bases is exact or approximate as it should be; pushed↔pushed and live↔pushed merges confirm and refute; parked work warns its owner; a request without access is refused; login, refresh, and the daemon and MCP sending the token.
- `pnpm typecheck`, `lint`, `fmt --check` clean; the latency benchmark still passes.

## What the tests forced

- **A confirmation is news.** The collision tracker announced a collision only when it started, so a warning that a speculative merge later confirmed or refuted never reached the daemon. It now re-announces when a collision's type, severity, confirmation or approximation changes.
- **`derivedId` left core.** It hashes with `node:crypto`, and `packages/core` must stay importable by the dashboard in a browser, so it lives in `packages/git` beside the other Node-only code.
- **A client's base can be newer than the mirror.** Translation asked for commits the last fetch had not seen. A lookup that finds a commit missing fetches once before giving up, and a failed lookup is retried after 60 s, not on every query.
- **The daemon fetches one commit, not the branch.** A speculative merge needs only the pushed head, which the warning names, so the daemon fetches that commit by id (`--no-write-fetch-head --no-tags`) and never moves the user's remote-tracking refs.
- **Only one instance may publish pushed work.** Instances fetch at different moments, so several publishers would keep overwriting each other with older views of the same branches: a deleted branch would come back from a mirror that had not fetched yet. One instance holds a Postgres advisory lock on a reserved connection and publishes; every instance still fetches, for its own translations and merges.
- **Parked work learns its collisions from the heartbeat.** Parked work has no stream of its own, so the daemon takes the warnings each parked heartbeat returns, and merges the parked head with every pushed head it overlaps. The results are kept per parked head, since a commit's merge never goes stale.
- **401 is not 403.** A token GitHub rejects and a user without access need different fixes (sign in again, or ask for access), so `GitHubApp.access` tells them apart, and treats a 403 with a spent rate limit as GitHub failing (503), not as a refusal.
- **Refresh tokens work once.** GitHub rotates the refresh token on every refresh, so a daemon and MCP servers refreshing together would spend the same token and sign the user out. They refresh under a lock file beside `credentials.json`, and re-read it inside the lock: whoever arrives second finds the new token. The fake GitHub's refresh tokens are single-use too, so the test fails without the re-read.
- **Running open is a choice.** A server with no GitHub App would otherwise accept every request silently. `startServer` refuses to start without either an App or an explicit authorizer; tests and the benchmark pass `allowAll`.
