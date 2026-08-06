# Git provider authentication (GitHub + GitLab)

How the harness resolves a git token **per user** and **per provider**
(GitHub or GitLab), how to seed it for both vault and env-only deployments,
and which `harness_health` fields flag a missing or invalid credential.

> Multi-user, multi-provider design: see issue #25. GitHub is fully supported
> end to end (token + push + PR). GitLab supports token resolution + push;
> automated merge-request creation is a tracked follow-up (the loop fails
> loud and asks you to open the MR manually).

## Where GitHub auth is used

There are **two** GitHub auth points, and they fail at different times:

1. **Plan phase** — before any git runs, the harness resolves a token to
   allocate the worktree and (later) push the branch. A missing token here
   fails the session immediately with a vault `not found` error. **This is
   the one that bites first.**
2. **Git transport** — the resolved token is handed to git via `GIT_ASKPASS`
   for clone/fetch/push. Setting only a git-transport env var (historically
   `GH_TOKEN` was read *only* inside the git adapter) does **not** unblock the
   plan phase.

Both now use the same resolver, so a single credential covers both.

## Resolution order (vault-first, env fallback)

Mirrors `models.auth`:

1. **Vault** — the credential service name is resolved by the PAT router from
   `pat_routing.default_service_pattern` (or an override). The harness calls
   `credential_get({ service, type: "token" })`.
2. **Env fallback** — if the vault lookup fails or is empty, the harness reads
   the environment variable named by `pat_routing.auth.api_key_env`
   (default `GH_TOKEN`). This lets vault-less deployments just set `GH_TOKEN`.
3. **Neither** — the session fails at plan phase; `harness_health` flags it
   (see below) so you catch it before starting a session.

**Credential type:** `token` (a GitHub PAT). Fine-grained or classic; it needs
`contents:write` and `pull_requests:write` on the target repos (plus repo
creation scope if you use `harness_bootstrap_test_repo`).

## The credential-name template

`pat_routing.default_service_pattern` builds the vault service name.
Placeholders (all lower-cased):

| Placeholder   | Value                                   | Example                  |
|---------------|-----------------------------------------|--------------------------|
| `{owner}`     | repo owner (user or org)                | `carelvanheerden`        |
| `{repo}`      | repo name                               | `openclaw-agent-harness` |
| `{provider}`  | `github` or `gitlab`                    | `github`                 |
| `{requester}` | requesting user's login for the provider (from `user_identities`; falls back to repo owner) | `alice-gh` |
| `{user}`      | requester login *(deprecated alias, repo owner if unknown)* | `carelvanheerden` |
| `{org}`       | repo owner *(deprecated alias of `{owner}`)*                | `carelvanheerden` |

**Default: `github-{owner}`** (per-owner tokens).

## Hierarchical routing (recommended for multi-user) — beta.25

The flat `default_service_pattern` cannot encode all the axes that matter for
a real team: **provider × org × person × purpose** (e.g. Carel's *private*
token vs Carel's *stitch* token). Beta.25 adds a first-class hierarchy:
`pat_routing.<provider>.<org>.<person>`.

```jsonc
{
  "pat_routing": {
    "github": {
      "stitch-vercel": {
        "Janice": {
          "token": { "env": "GH_STITCH_JANICE" },
          "name":  "Janice Doe",
          "email": "janice@stitch.example",
          "slack_user_id": "U0..."
        }
      },
      "CarelvanHeerden": {
        "CarelvanHeerden": {
          "token": { "value": "ghp_..." },
          "name":  "Carel van Heerden",
          "email": "carel@example.com",
          "slack_user_id": "U03HD5QEBFU"
        }
      }
    },
    "gitlab": {
      "exipay": {
        "CarelvanHeerden": { "token": { "env": "GL_EXIPAY_CAREL" }, "name": "...", "email": "...", "slack_user_id": "U0..." },
        "Francois":        { "token": { "vault": "gitlab-exipay-francois" }, "name": "...", "email": "...", "slack_user_id": "U0..." }
      }
    }
  }
}
```

- **org** = the repo *owner* (`owner/repo` → `owner`).
- **person** = *who is asking*, matched to the requester by `slack_user_id`.
- **token** = exactly one of `value` (inline secret in `openclaw.json`),
  `env` (env-var name), or `vault` (credential-vault service name).
- **name + email** become the git commit identity — colocated per person per
  org, so the same person may commit under different emails in different orgs.
- **No silent fallback.** If an org is configured here but the requester is
  not listed under it, the run fails with a clear
  "no token configured for requester" error rather than borrowing another
  user's token.

The hierarchy takes precedence over the legacy flat fields below, which remain
for back-compat.

### Vault is a first-class requirement for corporate multi-user

For a true multi-user deployment, install the **memory-hybrid** plugin and use
`vault` token pointers. Rationale:

- The operator **should not see** other users' tokens — with `vault`, the
  secret lives only in the encrypted credential store; `openclaw.json` holds
  just a pointer.
- Users **should not need to know their Slack user id** — when a user sets up
  their token by talking to OpenClaw, the `slack_user_id` is captured
  automatically from the inbound message.

The bundled **`harness-credentials`** skill (auto-installed with the plugin)
walks the agent through storing credentials in the correct tier:

1. **Vault** (recommended): store token in the vault under
   `harness-pat-{provider}-{org}-{person}`, add a `{ "vault": ... }` pointer,
   auto-capture the Slack id.
2. **Self-write `openclaw.json` + reload**: no vault, but the agent can edit
   config — writes an `env`/`value` pointer and reloads.
3. **Emit copy-paste JSON**: no vault and no config-write — the agent prints
   the exact snippet for the operator to paste (and the operator must add the
   `slack_user_id` by hand, since there is no auto-capture on a manual edit).

`value`/`env` (non-vault) pointers are fine for **single-operator or
small-team** setups where the operator accepts secrets living in config/env.
They are **not** appropriate for corporate multi-user, where the operator
must not be able to read colleagues' tokens.

### Preflight

Before a run, the harness checks it has routing + `name` + a valid `email` +
a resolvable token for the requester and target repo. If anything is missing
it returns an actionable message up front ("Before I run this on X I need a
git commit email and a github token…") instead of failing mid-run. Relay that
to the user and use the `harness-credentials` skill to fill the gap.

## Multi-user (per-requester) tokens (legacy flat template)

To give each requester their **own** token, map their Slack id to their
provider login and use `{requester}` (or `{provider}-{requester}`) in the
template:

```jsonc
{
  "pat_routing": {
    "default_service_pattern": "{provider}-{requester}",
    "user_identities": {
      "U07UT6G8LQ4": { "github": "carelvanheerden", "gitlab": "cvh" },
      "U0A5TEXC1LZ": { "github": "francois-l" }
    }
  }
}
```

The requester's Slack id is threaded from the session into resolution, so a
session started by Alice resolves `github-alice-gh` and one started by Bob
resolves `github-bob-gh`. A user with no configured identity falls back to the
repo owner, so the template never leaves an unresolved placeholder.

Per-user / per-repo `overrides` still win over the template.

## Multi-provider (GitHub + GitLab)

Provider is chosen by: explicit override > `provider_by_owner[owner]` >
`default_provider` (default `github`).

```jsonc
{
  "pat_routing": {
    "default_provider": "github",
    "provider_by_owner": { "my-gitlab-group": "gitlab" },
    "providers": {
      "github": { "api_base": "https://api.github.com",        "api_key_env": "GH_TOKEN" },
      "gitlab": { "api_base": "https://gitlab.com/api/v4",     "api_key_env": "GITLAB_TOKEN" }
    }
  }
}
```

Each provider has its own REST API base (for health pings) and its own env
fallback var. For a self-managed GitLab, point `providers.gitlab.api_base` at
`https://gitlab.example.com/api/v4`.

> **Why the default changed.** The old default `github-{user}-{org}` collapsed
> to a duplicated segment for a personal repo, because `{user}` (requester
> login) and `{org}` (repo owner) are the same value there — producing e.g.
> `github-carelvanheerden-carelvanheerden`, which was not in the vault.
> `{user}`/`{org}` still work as aliases for backwards compatibility, but
> prefer `{owner}` / `{owner}-{repo}`.

Common choices:

- `github-{owner}` — one token per account (default). Simplest.
- `github-{owner}-{repo}` — one token per repo. Tightest scoping.

Per-user / per-repo overrides still win over the template
(`pat_routing.overrides`).

## Seeding the token

### Vault (recommended)

Store a PAT under the service name your template produces, e.g. for
`CarelvanHeerden/openclaw-agent-harness` with the default template:

```
service: github-carelvanheerden
type:    token
value:   github_pat_...
```

### Env only (no vault plugin)

Set the provider's env var in the container environment: `GH_TOKEN` for
GitHub, `GITLAB_TOKEN` for GitLab (names configurable via
`providers.<p>.api_key_env`; the legacy `pat_routing.auth.api_key_env` still
wins for GitHub for back-compat). See `.env.example`. Note: env fallback is a
single shared token per provider — true per-user auth is vault-backed.

```jsonc
{
  "openclaw-agent-harness": {
    "pat_routing": {
      "default_service_pattern": "github-{owner}",
      "auth": { "api_key_env": "GH_TOKEN" }
    }
  }
}
```

## Health checks

`harness_health` surfaces GitHub auth so you don't discover a missing token at
plan phase:

- **`git_credential_resolvable`** — a token was found (vault or env) for the
  first allowed repo. **Fatal** to overall health when false.
- **`git_credential_live_ping`** — *(only with `{ deep: true }`)* a
  `GET /user` against the GitHub API with the resolved token, proving it
  actually authenticates. Catches expired/revoked tokens, distinguishing an
  auth rejection from an unrelated network error.

```jsonc
// harness_health
{ "deep": true }
```

## Disposable smoke-test repos

`harness_bootstrap_test_repo` creates a fresh repo under the requester's
account (seeded with a README + `docs/SMOKE.md`) and adds it to the **live**
allow-list, so smoke tests never touch the harness's own source repo.

```jsonc
// harness_bootstrap_test_repo
{ "owner": "CarelvanHeerden", "private": true }
```

- Uses the same GitHub token resolution as above.
- The allow-list addition is **in-memory only** — it survives until the next
  plugin (re-)register. To keep it, add the repo to `config.repos.allowed`.
- The repo is disposable; delete it from GitHub when you're done.

## Verification contracts and GitHub API calls (beta.9)

Several beta.9 contract kinds make direct GitHub API calls to verify remote
state. These calls use the **same PAT** resolved for the session's `requester`
via the vault / env chain above.

| Contract kind | GitHub API call |
|---------------|----------------|
| `remote_branch_exists` | `GET /repos/{owner}/{repo}/git/refs/heads/{branch}` |
| `file_pushed` | `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` |
| `pr_opened` | `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all` |
| `pr_state` | Same call as `pr_opened` |
| `file_in_pr` | `GET /repos/{owner}/{repo}/pulls/{number}/files` |
| `commit_sha_matches` | `GET /repos/{owner}/{repo}/git/refs/heads/{branch}` (SHA field) |

All of these are **read-only** calls; they do not create or modify any GitHub resource.

The `buildVerifyProbes` factory in the real adapter must be updated to supply
these probes before beta.9 is used in a live production session. See
`src/orchestrator/verify.ts` for the full `VerifyProbes` interface.
