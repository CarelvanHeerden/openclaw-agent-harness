# Authentication

This document explains **which credential path drives the lead / worker /
adversary / classifier models**, and how to configure it for a headless
(Dockerised) deployment.

## TL;DR

The harness runs Anthropic models through the embedded
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/typescript).
That SDK spawns the bundled Claude Code binary as a subprocess. With **no
explicit key**, the subprocess falls back to Claude Code's interactive
`/login` session store, which **does not exist in a headless container**. The
first session plan then dies immediately with:

```
Error: Claude Code returned an error result: Not logged in · Please run /login
```

To avoid this, configure an Anthropic API key. The harness resolves one
**vault-first, then env**, and injects it into the SDK subprocess as
`ANTHROPIC_API_KEY`, so `/login` is never needed.

## Configuration

Set `models.auth` in your plugin config:

```jsonc
{
  "openclaw-agent-harness": {
    "models": {
      "auth": {
        // Preferred: vault credential service name (type `api_key`).
        // Resolved via the same credential_get path used for GitHub PATs.
        "credential_service": "anthropic-harness",

        // Fallback: environment variable name holding the key.
        // Used only if credential_service is unset OR the vault lookup fails.
        // Default: "ANTHROPIC_API_KEY".
        "api_key_env": "ANTHROPIC_API_KEY"
      }
    }
  }
}
```

### Resolution order

1. **Vault** — if `models.auth.credential_service` is set, the harness calls
   `credential_get({ service, type: "api_key" })`. This is the recommended
   path: the key never lives in the container environment, it is auditable,
   and it matches how the harness already resolves GitHub PATs.
2. **Environment** — if the vault is unset or the lookup fails, the harness
   reads the env var named by `models.auth.api_key_env`
   (default `ANTHROPIC_API_KEY`).
3. **Neither** — the harness logs a warning and passes no key. The SDK keeps
   its default behaviour (may fall back to `/login`). This is fine for local
   dev where you are already logged in; it will fail in a headless container.

The resolved key is **memoised per runtime generation** (one vault hit per
(re-)register) and injected into every model call — lead, worker, adversary,
classifier, crystalliser — via the SDK subprocess `env`.

## Seeding the key in Docker

### Option A — vault (recommended)

Store the key once in the OpenClaw hybrid-memory credential vault:

```bash
# via the credential_store tool / hybrid-mem CLI, service name of your choice
service: anthropic-harness
type:    api_key
value:   sk-ant-...
```

Then set `models.auth.credential_service: "anthropic-harness"`. No key in the
container environment.

### Option B — environment variable

Set `ANTHROPIC_API_KEY` (or a custom name via `models.auth.api_key_env`) in
the container environment (compose `environment:`, a secrets mount, etc.).
Simpler, but the key lives in the container env.

> You do **not** need to mount a Claude Code `/login` session or run an
> interactive login inside the container. The API-key path above replaces it
> entirely.

## Verifying auth (health checks)

`harness_health` includes a **`model_auth_resolvable`** check that is **fatal
to overall health**: if no key resolves, health reports `DEGRADED` rather than
misleadingly reporting all-green while the first plan is doomed to fail.

For a stronger check, pass `{ "deep": true }` to `harness_health`. This does a
minimal live SDK call (a few tokens) to verify the key actually
**authenticates**, catching expired or invalid keys — not just missing ones:

```jsonc
// harness_health
{ "deep": true }
```

- `model_auth_resolvable` — a key was found (vault or env). Fatal if false.
- `model_auth_live_ping` — (deep only) the key authenticated against the SDK.
  Distinguishes an auth rejection from an unrelated network/ping failure.

## Which key, which model?

All four roles use the **same** Anthropic key; they differ only by model id
(`models.lead`, `models.worker`, `models.adversary`, `models.classifier`).
There is currently no per-role key support — one Anthropic account drives the
whole loop.
