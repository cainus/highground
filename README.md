# Highground

Highground tells developers and coding agents when someone else, on any branch, is changing the same lines they are. It is advisory and never blocks anyone. The design is in [docs/PRD.md](docs/PRD.md), and the words it uses are in [CONTEXT.md](CONTEXT.md).

## Trying it on your own machine

`./dev` runs everything for one person: the server and Postgres in Docker, open but reachable only from this machine, and the daemon in your terminal.

```sh
./dev watch ~/code/my-repo                               # once per repository: all its worktrees, as they come and go
./dev mcp                                                # once: Highground's tools in every Claude Code session
./dev                                                    # start, or update after a pull; Ctrl-C stops the daemon
./dev stop                                               # stop the server; its data is kept
```

The dashboard is on http://127.0.0.1:8090. `./dev` uses ports 8090 and 5434, so it runs beside services on 8080 and 5432.

## Running an instance

One image, `ghcr.io/cainus/highground`, holds the server and the dashboard. `docker-compose.yml` runs it with Postgres.

```sh
# Open to anyone who can reach the port: for trying it out on one machine.
HIGHGROUND_ALLOW_ALL=1 docker compose up --build
```

The dashboard and the API are then on http://localhost:8080, and `GET /healthz` answers 200 while the server can reach Postgres. `docker compose stop` stops the server cleanly; it writes everything still pending first.

A real instance uses a GitHub App instead (ADR 0004). The App provides sign-in, read access to each repository, and the mirror's fetches.

### Configuration

The server reads its settings from the environment. It refuses to start on a missing, partial or malformed setting, and names each one. Any secret `X` can be read from a file instead, by setting `X_FILE` to its path, as Docker mounts secrets.

| Variable                                                                              |                                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                        | Required. `postgres://user:password@host:5432/db`                                              |
| `HOST`, `PORT`                                                                        | Where to listen. Default `0.0.0.0` and `8080`                                                  |
| `PUBLIC_URL`                                                                          | The dashboard's origin, for OAuth redirects                                                    |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub App: all four or none. The private key may have its newlines escaped as `\n`        |
| `GITHUB_API_URL`, `GITHUB_WEB_URL`                                                    | For GitHub Enterprise Server                                                                   |
| `HIGHGROUND_ALLOW_ALL=1`                                                              | Run open, without a GitHub App. Refused alongside one                                          |
| `SESSION_KEY`                                                                         | 32 bytes in base64 (`openssl rand -base64 32`), for dashboard sign-in                          |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                              | Web Push for HIGH collisions. Needs dashboard sign-in                                          |
| `MIRROR_DIR`                                                                          | Where repositories are mirrored. Used only with a GitHub App. `/data/mirror` in the image      |
| `WEB_DIR`                                                                             | The built dashboard to serve. `/app/web` in the image                                          |
| `LOG_DIR`, `LOG_STDOUT=1`                                                             | Daily JSON-lines log files, kept 72 h, and a copy on stdout. `/data/logs` and on, in the image |

## Developing

Node 26 and pnpm. Postgres comes from the same compose file, and the tests start their own with Testcontainers.

```sh
pnpm install
docker compose up postgres            # Postgres on 127.0.0.1:5432
pnpm test                             # unit and integration tests
pnpm e2e                              # the dashboard in Chromium, against a real server
pnpm bench                            # latency at 100 working copies and 300 actors
pnpm typecheck && pnpm lint && pnpm fmt --check
```

`node scripts/smoke.ts <url>` checks a running open instance from outside, as CI does with the compose stack.
