# GitHub authentication

How the harness resolves a GitHub token, how to seed it for both vault and
env-only deployments, and which `harness_health` fields flag a missing or
invalid credential.

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

| Placeholder | Value                          | Example                     |
|-------------|--------------------------------|-----------------------------|
| `{owner}`   | repo owner (user or org)       | `carelvanheerden`           |
| `{repo}`    | repo name                      | `openclaw-agent-harness`    |
| `{user}`    | requester's GitHub login *(deprecated alias)* | `carelvanheerden` |
| `{org}`     | repo owner *(deprecated alias of `{owner}`)*  | `carelvanheerden` |

**Default: `github-{owner}`** (per-owner tokens).

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

Set `GH_TOKEN` in the container environment (or a custom name via
`pat_routing.auth.api_key_env`). See `.env.example`.

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
