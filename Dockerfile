# openclaw-agent-harness -- reference container image
#
# Not required for production (OpenClaw plugins run in-process by default),
# but useful for:
#   - running the built plugin in an isolated environment for real tests,
#   - CI reproducibility,
#   - future "hosted harness" deployment shape.
#
# Uses npm (matches CI) so no pnpm/corepack surprises. Node 24 is pinned
# to match OpenClaw's expected runtime.

# ---- Build stage ----
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Native compile for better-sqlite3
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so the layer cache is stable across source edits
COPY package.json package-lock.json ./
COPY tsconfig.json ./

# Full install (dev deps required for tsc + tests)
RUN npm_config_build_from_source=true npm ci

# Copy sources and build
COPY src ./src
COPY tests ./tests

RUN npm run build \
    && mkdir -p dist/state \
    && cp src/state/schema.sql dist/state/schema.sql

# Quick sanity: run the (dist-only) test suite in the build stage. We
# intentionally do NOT fail the image on test failure at this point --
# CI is the gate; this is a smoke check.
RUN node --test tests/*.mjs || echo "[dockerfile] tests failed in build stage (see logs)"

# ---- Runtime image ----
FROM node:24-bookworm-slim

# Non-root user matching OpenClaw defaults
RUN useradd --uid 1001 --user-group --create-home --shell /bin/bash openclaw \
    && mkdir -p /home/openclaw/.openclaw/workspace/openclaw-agent-harness \
    && chown -R openclaw:openclaw /home/openclaw

# git is required for the harness's worktree adapter
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

USER openclaw
WORKDIR /home/openclaw/app

COPY --chown=openclaw:openclaw --from=build /app/package.json ./
COPY --chown=openclaw:openclaw --from=build /app/package-lock.json ./
COPY --chown=openclaw:openclaw --from=build /app/dist ./dist
COPY --chown=openclaw:openclaw --from=build /app/node_modules ./node_modules

# Env defaults (override at deploy time)
ENV NODE_ENV=production
ENV OPENCLAW_HARNESS_STATE_DB=/home/openclaw/.openclaw/workspace/openclaw-agent-harness/state.db
ENV OPENCLAW_HARNESS_WORKTREE_ROOT=/home/openclaw/.openclaw/workspace/openclaw-agent-harness/worktrees

# tini keeps signal handling sane for the SDK's subprocess model
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default: print harness version. Real deployments override this with
# an entry point that loads the plugin into an OpenClaw runtime.
CMD ["node", "-e", "import('./dist/version.js').then(v => console.log('openclaw-agent-harness', v.pluginVersion, 'schema', v.schemaVersion));"]
