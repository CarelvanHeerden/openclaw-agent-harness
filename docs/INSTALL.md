# Installation

Prerequisites:

- OpenClaw **2026.6.1 or later**, running in a Node 22.13+ environment (the plugin's `engines.node` is `>=22.13.0`). `node:sqlite` is the whole persistence layer; it was *added* in 22.5.0 but stayed behind `--experimental-sqlite` until **22.13.0**, so on anything earlier the plugin cannot open its state store. rc.4 corrected this — through rc.3 the floor was advertised as 22.5.0, which does not work. Older releases dropped plugins this depends on, Slack among them, so 2026.6.1 is the earliest version the harness has actually been exercised against — not a theoretical floor. Development and testing through 1.0.0-rc.2 ran on `openclaw:2026.7.2-beta.7`.
- An Anthropic API key exposed to the OpenClaw container as `ANTHROPIC_API_KEY`.
- `pnpm` available inside the container (or wherever you run the plugin).
- A git provider token per person, per org, held in the harness's own credential vault. Onboard with `harness_onboard` (see [`CONFIGURATION.md`](CONFIGURATION.md#pat-routing)), or load them directly with `node scripts/vault.mjs set <service>`.

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
          "brief": {
            "request_file_roots": ["/home/node/.openclaw/media/inbound"]
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

`brief.request_file_roots` is the other one, and it is also empty by default.
Empty means `harness_run({ requestPath })` is **refused**, so a calling agent
that has the user's spec as a file has no way to hand it over except by retyping
it — reintroducing the paraphrase hop that `requestPath` exists to remove. Point
it at wherever your runtime stores uploads; for OpenClaw in Docker that is
`~/.openclaw/media/inbound`. A root that does not exist matches nothing, so
confirm it with a real file rather than assuming. See
[Brief fidelity](CONFIGURATION.md#brief-fidelity-briefrequest_file_roots).

See [`CONFIGURATION.md`](CONFIGURATION.md) for all options.

## 4. Store the GitHub PATs in the vault

The vault service name comes from `pat_routing.default_service_pattern`, which
defaults to `{provider}-{owner}` with the owner lower-cased. For
`Stitch-Vercel/ProjectThanos` on GitHub that is `github-stitch-vercel`:

```bash
# The secret is read from stdin, so it never lands in shell history or `ps`.
printf '%s' 'ghp_...' | node scripts/vault.mjs set github-stitch-vercel --type token
```

There is no `openclaw memory credential-store` step any more: beta.110 moved the
harness onto its own vault and removed the memory-hybrid path entirely, with no
fallback. The CLI opens the same directory the running plugin does, and prints
which one on every invocation — check that line if a token appears stored but
cannot be found.

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

Ask your OpenClaw agent, in a channel or DM it is already listening to:

```
Use the harness to add a comment to README.md in example-org/example-repo
saying hello from the agent harness.
```

**The harness itself does not read Slack.** beta.34 removed the listener, so a
message beginning `harness:` posted into the configured channel does nothing at
all — the agent has to call `harness_run`. If nothing happens, that is the first
thing to check, and it is the most common reason a fresh install looks dead.

Expected behaviour:

1. The agent calls `harness_run` and reports a session id back to you.
2. It may relay **one** clarifying question; answer it in the same conversation.
3. The lead plans a single worker sub-task.
4. Worker edits `README.md` and commits to a new branch — workers never push.
5. Adversarial reviewer returns `pass`, `revise` or `block`.
6. The harness pushes the branch under your GitHub identity and opens a PR
   (not a draft, unless you set `repos.draft_pr_on_nonpass`).
7. You get the PR link and a cost summary.

Poll `harness_progress` while it runs. Relay its terminal headline verbatim: a PR
flagged `do_not_merge` is a PR that shipped with findings outstanding, and it
reads as ordinary success if you paraphrase it.

## Troubleshooting

- **`claude --version` fails inside container.** Rebuild the image with the Dockerfile changes in step 1.
- **`ANTHROPIC_API_KEY missing`.** Resolution is vault-first: set `models.auth.credential_service` and store the key with `printf '%s' 'sk-ant-...' | node scripts/vault.mjs set <service> --type api_key`. Failing that the SDK inherits `ANTHROPIC_API_KEY` from `process.env`, so the container env still works as a fallback.
- **A token is in the vault but the harness cannot find it.** Compare the path `scripts/vault.mjs` prints on startup with `<dirname of storage.state_db_path>/harness-vault`. They agree by default from 1.0.0-rc.2; before that the CLI wrote to `~/.openclaw/harness/harness-vault`, which nothing read. Re-seed if you installed earlier, or point the CLI with `--dir`.
- **GitHub PAT 401.** Confirm the token has `repo` scope. For org-level SAML SSO enforcement, authorise the token via the org's PAT settings page.
- **Session stuck.** Check `~/.openclaw/workspace/openclaw-agent-harness/state.db`, table `sessions`, for the row's status. If `interrupted`, use the plugin's `harness_resume` tool.
- **Costs unexpectedly high.** Inspect `audit_log` and `sub_tasks` for the offending session. Consider lowering `session_default_usd` in config.
