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

# rc.3: the python3/make/g++ toolchain and `npm_config_build_from_source` that
# used to live here were for `better-sqlite3`, which this project does not
# depend on -- persistence is `node:sqlite`, built into Node (see the header of
# src/state/store.ts). Nothing in the tree COMPILES at install time, so the
# compiler was dead weight in the build image. An external review read the
# leftover as a contradiction of store.ts's "ZERO native dependencies"; store.ts
# was right and the Dockerfile was stale.
#
# `opencode-ai` does ship a native executable, but a PREBUILT one selected by
# per-platform optional dependencies -- it is downloaded, never compiled, so it
# does not bring the toolchain back. It does mean `npm ci` now resolves a
# platform-specific package, so build and runtime must stay the same platform;
# they are the same base image here, so they do.

# Copy manifests first so the layer cache is stable across source edits
COPY package.json package-lock.json ./
COPY tsconfig.json ./

# Full install (dev deps required for tsc + tests)
RUN npm ci

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

# v2.0.0-beta.1: the OpenCode backend, baked in at a pinned version.
#
# Baked rather than fetched with `npx -y opencode-ai@latest` at run time, which
# is what the capability probe used. `@latest` means the agent the container
# runs is decided by whoever published most recently, so an image that passed
# its smoke test on Monday can be running different code on Tuesday with no
# change on our side -- and the thing that would change silently is the process
# the worker's tool calls flow through. It also puts a network fetch on the
# startup path of every session.
#
# The version is warn-on-mismatch rather than enforced at runtime (see
# src/adapters/opencode-version.ts): the real gate is the live permission probe
# that runs at startup and refuses to proceed unless the tool-call round-trip
# is observed. Keep this in lockstep with PINNED_OPENCODE_VERSION -- a test
# asserts they agree.
#
# NO LONGER INSTALLED GLOBALLY HERE. `opencode-ai` is a production dependency,
# so the `npm ci` in the build stage installs it and the node_modules copy
# below carries it into the runtime image. A global install would be a second
# copy of a ~150 MB binary, and worse, a second version that could drift from
# the one package.json names.

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
