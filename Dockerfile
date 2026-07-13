# openclaw-agent-harness — reference container image
#
# Not required for production (OpenClaw plugins run in-process by default),
# but useful for:
#   - running the built plugin in an isolated environment for real tests,
#   - CI reproducibility,
#   - future "hosted harness" deployment shape.
#
# We deliberately pin the Node major to match OpenClaw's expected runtime.

FROM node:24-bookworm-slim AS build

WORKDIR /app

# Copy sources first so the layer cache tracks them
COPY package.json pnpm-lock.yaml* ./
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests

# Enable pnpm via corepack (matches lockfile). We install ALL deps because
# tsc + tests need dev deps too.
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate \
    && env npm_config_build_from_source=true pnpm install --frozen-lockfile

# Build the plugin (compile TS + copy schema.sql into dist).
RUN pnpm run build \
    && mkdir -p dist/state \
    && cp src/state/schema.sql dist/state/schema.sql

# ---- Runtime image ----
FROM node:24-bookworm-slim

# Non-root user matching OpenClaw defaults
RUN useradd --uid 1001 --user-group --create-home --shell /bin/bash openclaw \
    && mkdir -p /home/openclaw/.openclaw/workspace/openclaw-agent-harness \
    && chown -R openclaw:openclaw /home/openclaw

# git is required for the harness's worktree adapter
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

USER openclaw
WORKDIR /home/openclaw/app

COPY --chown=openclaw:openclaw --from=build /app/package.json ./
COPY --chown=openclaw:openclaw --from=build /app/pnpm-lock.yaml* ./
COPY --chown=openclaw:openclaw --from=build /app/dist ./dist
COPY --chown=openclaw:openclaw --from=build /app/node_modules ./node_modules

ENV NODE_ENV=production
ENV OPENCLAW_PLUGIN_ID=openclaw-agent-harness

# No default CMD -- the container is used as a plugin sidecar or CI harness
# runner. Callers set their own entrypoint.
