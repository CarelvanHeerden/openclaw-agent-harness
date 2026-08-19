# Installation

Prerequisites:

- OpenClaw >= 2026.5.0 running in a Node 22+ environment (the plugin's `engines.node` is `>=22.0.0`, matching the OpenClaw plugin SDK).
- An Anthropic API key exposed to the OpenClaw container as `ANTHROPIC_API_KEY`.
- `pnpm` available inside the container (or wherever you run the plugin).
- GitHub personal access tokens stored in the OpenClaw credential vault. See [`CONFIGURATION.md`](CONFIGURATION.md#pat-routing) for naming, and read the consistency note there before using `harness_onboard`.

### No native dependencies, no toolchain

The plugin has **zero native dependencies**. Persistence uses Node's built-in
`node:sqlite`, so there is no `better-sqlite3`, no prebuild to match against
your Node ABI, and no `node-gyp` fallback needing `build-essential`. Any
platform Node 22+ runs on will do, including linux/arm64 (Apple Silicon), which
earlier releases could not install on without a compiler.

If you are reading an older copy of this file that warns about
`Error: Could not locate the bindings file`, that failure mode no longer exists.

## 1. The Claude Agent SDK needs no separate install

`@anthropic-ai/claude-agent-sdk` is a plain runtime dependency of the plugin, so
`npm install --omit=dev` (the mode OpenClaw runs on git installs) fetches it.
No Dockerfile change is required.

If you also want the interactive CLI available for debugging, that one *is* a
separate global install:

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

Edit `~/.openclaw/openclaw.json` (or use `openclaw config patch`) and add the
plugin config. Note the shape: plugin settings live under
`plugins.entries.<id>.config`, **not** `plugins.<id>`. Configuration written at
the shorter path is silently ignored. Minimal example:

```json
{
  "plugins": {
    "entries": {
      "openclaw-agent-harness": {
        "enabled": true,
        "config": {
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
            "allowed": ["example-org/example-repo"],
            "never_commit_paths": ["okf/**"]
          },
          "models": {
            "lead": "claude-fable-5",
            "worker": "claude-sonnet-5",
            "adversary": "claude-fable-5"
          }
        }
      }
    }
  }
}
```

`slack.authorised_users` must contain at least one id even when you are not
driving the harness from Slack: config validation refuses an empty list, and the
first entry is the fallback requester identity.

`slack.channel` is optional. Do not set `slack.listener_enabled` — beta.34
removed the autonomous listener and the flag has been ignored since.

`repos.never_commit_paths` is the one setting you have to decide per repo. If an
allow-listed repo keeps a **generated bundle checked in** — generated API docs, a
regenerated schema index, snapshot fixtures — list it here. Workers stage with
`git add -A`, so a build step that regenerates that tree sweeps all of it into
the commit; one real run committed 141 generated files alongside 13 real ones,
and the out-of-scope findings that follow are blocking and unfixable, because
regenerating was the job. The list is empty by default and is never inferred,
since a generated tree cannot be told from hand-written code by inspection, and
nothing will warn you if you leave it out. Drop the line if your repo has no
such tree. See [Generated trees](CONFIGURATION.md#generated-trees-reposnever_commit_paths).

See [`CONFIGURATION.md`](CONFIGURATION.md) for all options.

## 4. Store the GitHub PATs in the vault

The vault service name comes from `pat_routing.default_service_pattern`, which
defaults to `{provider}-{owner}` with the owner lower-cased. For
`Stitch-Vercel/ProjectThanos` on GitHub that is `github-stitch-vercel`:

```bash
openclaw memory credential-store --service github-stitch-vercel --type token --value 'ghp_...'
```

If you use `harness_onboard` with `action:"add"`, none of this applies: that
flow writes the routing entry as well as the secret, so the two cannot disagree
and no pattern needs to line up. It is the right choice when one person holds
different tokens for different orgs.

The pattern below matters only for the **legacy flat flow**
(`harness_onboard action:"submit"` with `legacy:true`), which stores a single
token per user. There,
`pat_routing.onboard_service_pattern` must be able to produce the same string as
`default_service_pattern` — they share only the `{userid}` placeholder, and the
two defaults (`git-pat:{userid}` and `{provider}-{owner}`) cannot agree. Since
beta.133 onboarding refuses rather than storing a token nothing will read, but
it is easier to set the patterns correctly up front. Legacy per-(user, org)
naming still works if you set the pattern explicitly:

```bash
# example naming convention. The secret is read from stdin, so it never lands
# in shell history or in `ps` output.
printf '%s' 'ghp_...' | node scripts/vault.mjs set github-carel-example-org
printf '%s' 'ghp_...' | node scripts/vault.mjs set github-carel-personal
printf '%s' 'ghp_...' | node scripts/vault.mjs set github-francois-example-org

node scripts/vault.mjs list   # names, types and timestamps -- never values
```

beta.110: these go into the harness's own vault (`<dataDir>/harness-vault`), not
the memory plugin. On first run the harness generates `vault.key` at mode 0600 —
**back it up**, because without it every stored credential is unrecoverable. Set
`OAH_VAULT_KEY` instead if you would rather inject the key at container start.

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
