---
name: harness-credentials
description: >-
  Set up and store git credentials (GitHub / GitLab tokens + commit identity)
  for the openclaw-agent-harness so it can commit and push on a user's behalf.
  Use this skill whenever a user says they want the harness to work in a repo,
  offers a personal access token, asks how to add their token, hits a
  "no token configured for requester" / preflight error, or when the harness
  needs a token/email it does not yet have. Handles the vault (recommended),
  self-write openclaw.json, and manual copy-paste tiers, and always captures
  the requester's Slack user id automatically where possible.
---

# Harness Credentials

The openclaw-agent-harness commits and pushes code **as a specific person**.
To do that it needs, per (git provider × repo owner/org × person):

- a **token** (GitHub PAT / GitLab token),
- a **commit name** and **commit email**,
- the person's **Slack user id** (so an inbound request maps to the right token).

This skill sets that up correctly. **Never echo a token back** after receiving
it, and ask the user to redact/delete the message once stored.

## The config shape

Routing is hierarchical: `provider → org → person → { token, name, email, slack_user_id }`.

```json
"pat_routing": {
  "github": {
    "stitch-vercel": {
      "Janice": {
        "token": { "env": "GH_STITCH_JANICE" },
        "name": "Janice Doe",
        "email": "janice@stitch.example",
        "slack_user_id": "U0..."
      }
    },
    "CarelvanHeerden": {
      "CarelvanHeerden": {
        "token": { "value": "ghp_..." },
        "name": "Carel van Heerden",
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
```

- **org** = the repo *owner* (`owner/repo` → `owner`).
- **person** = *who is asking* (matched to the requester by `slack_user_id`).
- **token** = exactly one of `value` (inline), `env` (env var name), or
  `vault` (credential-vault service name).
- **No silent fallback:** if a requester is not listed under an org that IS
  configured, the harness hard-fails rather than borrowing another user's token.

## Collect these before doing anything

Ask the user for whatever is missing. You need **all** of:

1. **Repo(s)** they want to work in (→ gives provider + org). If unclear which
   provider, ask GitHub or GitLab.
2. **Token** for that provider/org.
3. **Commit email** (required — the harness fails a run without it).
4. **Commit name** (default to their display name if they don't specify).

The **Slack user id** you already have: it is the sender of the current
message (inbound metadata). Do NOT ask the user for it in the vault or
self-write tiers — capture it automatically. Only the manual copy-paste tier
requires the operator to fill it in by hand.

## Pick the tier

Decide capability first:

- **Vault available?** Check for the memory-hybrid credential tools
  (`credential_store` / `credential_get`). If present → **Tier 1**.
- **Can you write `openclaw.json` and reload?** If the gateway config tool /
  write access is available → **Tier 2**.
- **Neither?** → **Tier 3** (emit copy-paste JSON).

### Tier 1 — Vault (recommended, corporate multi-user)

This is the **first-class** path for multi-user setups: the operator never
sees other users' tokens, and users never type their Slack id.

1. The moment the token is offered, immediately store it in the vault
   (do not summarise or acknowledge first). Use a structured service name:
   `harness-pat-{provider}-{org}-{person}`, lower-cased, e.g.
   `harness-pat-github-stitch-vercel-janice`.
   - `credential_store` with `type: "token"`, the token as the value, and put
     the email + Slack user id in the credential's notes/metadata.
2. Add / update the person node in `pat_routing` with
   `"token": { "vault": "harness-pat-github-stitch-vercel-janice" }`,
   plus `name`, `email`, and the auto-captured `slack_user_id`.
   (If you can't write config, hand the operator the snippet — see Tier 3 —
   but the *secret* still lives only in the vault.)
3. Confirm what was stored (service name only, never the value) and ask the
   user to delete their message.

### Tier 2 — Write openclaw.json + reload

Use when there's no vault but you can edit config.

1. Read the current `openclaw.json` harness config. **Preserve and merge** —
   never clobber the whole `pat_routing` block.
2. Insert the person node under `pat_routing.<provider>.<org>.<person>` with
   the auto-captured `slack_user_id`. For the token, prefer
   `{ "env": "VAR_NAME" }` and tell the operator to set that env var, OR use
   `{ "value": "..." }` inline if the user explicitly accepts the risk of a
   secret in the config file.
3. Trigger a config reload (gateway restart/reload). Verify the reload was
   accepted (watch for `config reload skipped (invalid config)`).
4. Confirm and ask for message redaction.

### Tier 3 — Emit copy-paste JSON (no vault, no write access)

You can't persist anything, so produce the exact snippet the operator pastes
into `openclaw.json` under `harness.pat_routing`.

- Fill in provider, org, person, name, email.
- For the token use `{ "env": "VAR_NAME" }` (recommended) or `{ "value": "..." }`.
- **You must include a `slack_user_id`** — since this is manual, tell the
  operator the correct value (it is the requester's Slack user id, which you
  have from the message context) and remind them it must be present or the
  harness will not match the requester.

Example message to the operator:

> Add this under `harness.pat_routing` in `openclaw.json`, then reload:
> ```json
> "github": { "stitch-vercel": { "Janice": {
>   "token": { "env": "GH_STITCH_JANICE" },
>   "name": "Janice Doe",
>   "email": "janice@stitch.example",
>   "slack_user_id": "U0..."
> } } }
> ```
> Then set `GH_STITCH_JANICE` in the gateway environment.

## Preflight

The harness runs a **preflight** before a session: it checks routing + name +
email + token for the requester and the target repo. If it returns
`preflightIncomplete`, relay its `message` to the user and gather exactly the
missing piece(s), then use the right tier above to store them. Do not start a
run with incomplete credentials.

## Security rules

- Store secrets in the vault (Tier 1) whenever available; never put a token in
  memory files, notes, or chat logs.
- Never print a token back to the user or into logs.
- After storing, ask the user to delete the message containing the token.
- Inline `value` tokens in `openclaw.json` are allowed only when the setter
  explicitly accepts the risk (single-operator / small-team).
