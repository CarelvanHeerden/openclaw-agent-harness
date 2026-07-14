# Installation

Prerequisites:

- OpenClaw >= 2026.5.0 running in a Node 22+ environment (the plugin's `engines.node` is `>=22.0.0`, matching the OpenClaw plugin SDK).
- An Anthropic API key exposed to the OpenClaw container as `ANTHROPIC_API_KEY`.
- `pnpm` available inside the container (or wherever you run the plugin).
- GitHub personal access tokens stored in the OpenClaw credential vault, one per (user, org). See [`CONFIGURATION.md`](CONFIGURATION.md#pat-routing) for naming.
- **`better-sqlite3` prebuilt binary must be available for your Node ABI.** The plugin depends on `better-sqlite3@12.11.1+`, which ships prebuilds for Node ABI 127 (Node 22), 137 (Node 24), 141 (Node 25), and 147 (Node 26) on linux-x64. If OpenClaw is running on a Node version outside that set (e.g. Node 23, which is EOL, or something exotic like linux-arm64 without a matching prebuild), `prebuild-install` will fall back to `node-gyp rebuild`, which requires a C/C++ toolchain: Debian/Ubuntu `apt-get install -y build-essential python3`, Alpine `apk add --no-cache build-base python3`. The stock OpenClaw Docker image on `node:24` already has a matching prebuild available; no toolchain needed.

### Troubleshooting: `Error: Could not locate the bindings file`

Symptom on `openclaw plugins list` or gateway startup:

```
plugin failed during register: Error: Could not locate the bindings file. Tried:
  → .../node_modules/better-sqlite3/build/Release/better_sqlite3.node
  ...
  → .../node_modules/better-sqlite3/lib/binding/node-v137-linux-x64/better_sqlite3.node
```

This means `npm install --omit=dev` (the mode OpenClaw runs on git installs) neither found a prebuilt native module for your Node version + platform, nor could it compile one (no `make`/`g++` in the container). Options:

1. **Confirm the plugin is on `better-sqlite3@12.11.1` or newer.** v11.10.0 does NOT publish a prebuild for Node 24 (ABI 137). If you see the plugin pinned to an older version, upgrade the plugin.
2. **Run OpenClaw on a Node LTS with prebuilds available.** As of `better-sqlite3@12.11.1`, that's Node 22 (ABI 127), 24 (ABI 137), 25 (ABI 141), or 26 (ABI 147) on linux-x64.
3. **Install a C/C++ toolchain** in the container so `node-gyp` can compile from source: Debian/Ubuntu `apt-get install -y build-essential python3`, Alpine `apk add --no-cache build-base python3`, then reinstall the plugin.

You can check your Node ABI with `docker exec -it openclaw-gateway node -p 'process.versions.modules'` (returns e.g. `137` for Node 24).

## 1. Install the Claude Agent SDK

The harness embeds `@anthropic-ai/claude-agent-sdk`. Install into your OpenClaw container image via a Dockerfile addition:

```dockerfile
# after the existing OpenClaw install steps, before USER node:

RUN npm install -g @anthropic-ai/claude-agent-sdk \
 && mkdir -p /home/node/.claude \
 && chown -R 1001:1001 /home/node/.claude
```

If you also want the interactive CLI available for debugging:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Persistent session directory (mount as a volume):

```yaml
# docker-compose or Unraid template
volumes:
  - /mnt/user/appdata/openclaw/claude:/home/node/.claude
```

## Expected `security audit` warning (read before installing)

After install, `openclaw security audit` will report a **critical** `plugins.code_safety` finding:

```
Plugin "openclaw-agent-harness" contains dangerous code patterns:
  Shell command execution detected (child_process)
  (src/adapters/git-worktree.ts:172)
  (dist/adapters/git-worktree.js:149)
```

This is expected. The harness runs `git` as a subprocess (add worktree, commit, push, etc.); OpenClaw's scanner flags any `child_process` use as critical and offers no per-plugin allowlist. **Install itself is NOT blocked** -- the built-in install-time dangerous-code scanner has been removed in current OpenClaw releases.

Before installing, please read [`SECURITY.md`](../SECURITY.md) for the full call-site review (single file, `spawn("git", args, {env})`, no `shell: true`, no user-controlled executable path).

## Install-time flags you may need

### `TMPDIR=<same-fs-as-plugins>` -- avoid `EXDEV` cross-device rename

OpenClaw stages the git clone in the OS temp dir (`/tmp` on most Linux hosts), then renames it into the persistent plugins directory. If those two paths sit on different filesystems (common on Docker + Unraid: `/tmp` is `tmpfs`, plugin dir is a bind-mounted overlay), the atomic `rename(2)` fails with `EXDEV: cross-device link not permitted` and install aborts.

Workaround: point `TMPDIR` at a directory on the same filesystem as `~/.openclaw`:

```bash
docker exec -it openclaw-gateway sh -c \
  "TMPDIR=/home/node/.openclaw/tmp openclaw plugins install git:github.com/CarelvanHeerden/openclaw-agent-harness"
```

(You may need `mkdir -p /home/node/.openclaw/tmp` inside the container first if it does not exist.)

### `--dangerously-force-unsafe-install` -- may be needed while `security.installPolicy` is not configured

On OpenClaw releases that still enforce install-time policy blocking, the `plugins.code_safety` finding for `child_process` (see the SECURITY WARNING section above) may refuse install unless you either configure `security.installPolicy` in your OpenClaw config or pass `--dangerously-force-unsafe-install`:

```bash
docker exec -it openclaw-gateway sh -c \
  "TMPDIR=/home/node/.openclaw/tmp openclaw plugins install git:github.com/CarelvanHeerden/openclaw-agent-harness --dangerously-force-unsafe-install"
```

On newer releases this flag is a no-op (install-time scanning has been removed per OpenClaw's own deprecation notice) and can be omitted. Passing it always is harmless.

## 2. Install the plugin

### Recommended: OpenClaw plugin installer (from git)

```bash
docker exec -it openclaw-gateway openclaw plugins install git:github.com/CarelvanHeerden/openclaw-agent-harness
```

This clones the repo, runs `npm install --omit=dev`, and registers the plugin. `dist/` is committed to the repo (see `.gitignore`), so no build step is required at install time. This is deliberate: OpenClaw's git installer strips devDependencies, which means `typescript` and other build tooling would be unavailable if we tried to build post-clone.

### Alternative: manual clone (for development)

Only needed if you plan to modify the plugin source:

```bash
git clone https://github.com/CarelvanHeerden/openclaw-agent-harness \
  ~/.openclaw/plugins/openclaw-agent-harness
cd ~/.openclaw/plugins/openclaw-agent-harness
pnpm install     # includes devDependencies
pnpm build       # rebuild dist/ after src/ changes
```

After local edits, run `pnpm build` and commit `dist/` alongside your `src/` changes. CI will fail if the committed `dist/` is stale.

## 3. Configure

Edit `~/.openclaw/openclaw.json` (or use `openclaw config patch`) and add the plugin config. Minimal example:

```json
{
  "plugins": {
    "openclaw-agent-harness": {
      "slack": {
        "channel": "C0XXXXXXXXX",
        "authorised_users": ["U07UT6G8LQ4"]
      },
      "budgets": {
        "monthly_per_user_usd": 1000,
        "session_default_usd": 50,
        "session_hard_ceiling_usd": 200
      },
      "repos": {
        "allowed": ["example-org/example-repo"]
      },
      "models": {
        "lead": "claude-fable-5",
        "worker": "claude-sonnet-5",
        "adversary": "claude-fable-5"
      }
    }
  }
}
```

See [`CONFIGURATION.md`](CONFIGURATION.md) for all options.

## 4. Store the GitHub PATs in the vault

Using OpenClaw's credential vault, add one entry per (user, org):

```bash
# example naming convention
openclaw memory credential-store --service github-carel-example-org   --type token --value 'ghp_...'
openclaw memory credential-store --service github-carel-personal        --type token --value 'ghp_...'
openclaw memory credential-store --service github-francois-example-org --type token --value 'ghp_...'
```

Do NOT run these commands with the gateway live; add them via a maintenance window, or use the plugin `credential_store` tool from a session.

## 5. Restart the gateway

```bash
docker restart openclaw-gateway
```

Or via OpenClaw's `gateway restart` tool.

## 6. Smoke test

Post the following in your configured Slack channel:

```
harness: add a comment to README.md saying hello from the agent harness
```

Expected behaviour:

1. The harness starts a thread.
2. It asks 1-2 clarifying questions (or accepts the prompt as-is if it deems it clear).
3. Fable-5 lead plans a single Sonnet worker sub-task.
4. Worker edits `README.md`, commits to a new branch.
5. Adversarial reviewer signs off.
6. Draft PR opens under your GitHub identity.
7. Slack thread posts the PR link + cost summary.

## Troubleshooting

- **`claude --version` fails inside container.** Rebuild the image with the Dockerfile changes in step 1.
- **`ANTHROPIC_API_KEY missing`.** Set it in the container env; the SDK inherits from `process.env`.
- **GitHub PAT 401.** Confirm the token has `repo` scope. For org-level SAML SSO enforcement, authorise the token via the org's PAT settings page.
- **Session stuck.** Check `~/.openclaw/workspace/openclaw-agent-harness/state.db`, table `sessions`, for the row's status. If `interrupted`, use the plugin's `harness_resume` tool.
- **Costs unexpectedly high.** Inspect `audit_log` and `sub_tasks` for the offending session. Consider lowering `session_default_usd` in config.
