# syntax=docker/dockerfile:1
# Highground: the server and the built dashboard in one image (PRD §11, plan 06).

FROM node:26-slim AS pnpm
# Node 25 stopped shipping corepack, so pnpm comes from its own release, at the version
# package.json pins, as the standalone binary for this platform.
ARG PNPM=10.34.7
ARG TARGETARCH
RUN node -e '\
  const arch = { amd64: "x64", arm64: "arm64" }[process.env.TARGETARCH] ?? process.arch; \
  const url = `https://github.com/pnpm/pnpm/releases/download/v${process.env.PNPM}/pnpm-linux-${arch}`; \
  fetch(url).then(async (r) => { \
    if (!r.ok) throw new Error(`${url}: ${r.status}`); \
    require("node:fs").writeFileSync("/usr/local/bin/pnpm", Buffer.from(await r.arrayBuffer()), { mode: 0o755 }); \
  });' \
  && pnpm --version
WORKDIR /app
# Every workspace manifest, so the lockfile matches whichever packages a stage installs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/git/package.json packages/git/
COPY packages/log/package.json packages/log/
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

FROM pnpm AS web
RUN pnpm install --frozen-lockfile --filter "@highground/web..."
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @highground/web build

FROM pnpm AS deps
# Production dependencies of the server and the packages it uses. Workspace packages
# stay symlinks into packages/: Node strips types everywhere but under node_modules.
RUN pnpm install --prod --frozen-lockfile --filter "@highground/server..."

FROM node:26-slim
# git for the mirror: fetches, diffs and speculative merges.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=deps /app ./
COPY packages/core/src packages/core/src
COPY packages/git/src packages/git/src
COPY packages/log/src packages/log/src
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY --from=web /app/apps/web/dist web
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8080 \
  WEB_DIR=/app/web \
  MIRROR_DIR=/data/mirror \
  LOG_DIR=/data/logs
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/server/src/main.ts"]
