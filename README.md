# openclaw-agent-harness

**Multi-agent orchestration harness for OpenClaw.** Drives Claude Code (via `@anthropic-ai/claude-agent-sdk`) with a Fable-5 orchestrator, Sonnet workers, and a Fable-5 adversarial reviewer, controlled from Slack.

> **Status:** early development. Nothing here is stable yet.
> **License:** MIT.
> **Ecosystem:** designed as an [OpenClaw](https://github.com/openclaw/openclaw) plugin, generic enough to be useful outside Stitch's setup.

---

## Why

Cursor Agent / interactive Claude Code sessions bind you to a laptop and an IDE. This harness lets a small team (starts at two people) hand off multi-step coding tasks to a server-side agent running inside an always-on OpenClaw container. It:

- accepts a task prompt via a dedicated private Slack channel,
- refines the prompt with the requester over 2-3 turns,
- plans and executes the work with a **Fable-5 lead** agent that delegates bounded sub-tasks to **Sonnet workers**,
- reviews every attempt with a **Fable-5 adversarial** agent that checks spec fidelity, codebase fit, security, and runtime behaviour (via Vercel logs),
- loops up to 3 times with early-exit on clean adversarial sign-off or budget hit,
- opens the PR under the requester's own GitHub identity (per-user PATs, per-org routing).

## Architecture (high level)

```
Slack #dev-channel
        |
        v
  Harness plugin  (this repo)
        |
        +--> Crystallisation (multi-turn prompt refinement)
        |
        +--> Fable-5 lead orchestrator
        |         |
        |         +--> Sonnet worker 1 (bounded sub-task)
        |         +--> Sonnet worker 2
        |         +--> ...
        |
        +--> Fable-5 adversarial reviewer
        |         (spec fidelity + codebase fit + security + Vercel logs)
        |
        +--> Loop up to 3x with early exit
        |
        +--> Branch push + draft PR under requester's GitHub identity
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Runtime | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), not CLI subprocess | Typed events, structured tool results, first-class session/resume |
| Lead model | `claude-fable-5` | Long-running planner, worth the price |
| Worker model | `claude-sonnet-5` | Fast, cheap, bounded scope |
| Adversarial model | `claude-fable-5` | Must be at least as smart as the lead to catch its mistakes |
| Invocation | Post in a dedicated Slack channel (no slash command) | Zero-friction for the two-person team |
| PAT routing | Per-user, per-org tokens in OpenClaw's credential vault | Commits show up under the requester's own GitHub identity |
| State | Local SQLite at `~/.openclaw/workspace/openclaw-agent-harness/state.db` | Isolated from hybrid-memory DB, easy to inspect |
| Budgets | $1000 / user / month hard cap; per-session defaults with user override | Prevents runaway spend |
| Repo scope | Explicit allow-list per session; can create new blank repos on request | Prevents accidental escapes |

## Non-goals

- Not a general-purpose Claude Code SaaS.
- Not replacing IDEs; humans still review and merge.
- Not exposing itself to public Slack channels or unknown users.

## Configuration (plugin manifest)

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full plugin config reference.

Minimal example:

```json
{
  "openclaw-agent-harness": {
    "slack": {
      "channel": "C0XXXXXXXXX",
      "authorised_users": ["U07UT6G8LQ4"]
    },
    "budgets": {
      "monthly_per_user_usd": 1000,
      "session_default_usd": 50,
      "session_hard_ceiling_usd": 200,
      "daily_warn_usd": 100
    },
    "repos": {
      "allowed": ["Stitch-Vercel/ProjectThanos"],
      "can_create": true,
      "create_org": "Stitch-Vercel",
      "create_visibility": "private"
    },
    "models": {
      "lead": "claude-fable-5",
      "worker": "claude-sonnet-5",
      "adversary": "claude-fable-5"
    },
    "loop": {
      "max_cycles": 3,
      "adversarial_pass_ends_early": true
    },
    "vercel": {
      "enabled": false,
      "credential_service": "vercel-projectthanos"
    }
  }
}
```

## Installation

See [`docs/INSTALL.md`](docs/INSTALL.md). Short version:

```bash
# In your OpenClaw workspace or plugins directory:
git clone https://github.com/CarelvanHeerden/openclaw-agent-harness ~/.openclaw/plugins/openclaw-agent-harness
cd ~/.openclaw/plugins/openclaw-agent-harness
pnpm install
pnpm build
# Add the plugin manifest snippet to your openclaw.json
# Restart the gateway
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

The plugin embeds `@anthropic-ai/claude-agent-sdk` for the actual coding agent, but the harness itself is agent-agnostic in the abstract: a lead planner, bounded workers, an adversarial reviewer, a state machine, and Slack IO.

## Roadmap

- **Phase 0:** feasibility spike (SDK install, basic `claude -p` runs, session persistence)
- **Phase 1:** MVP - single-user, single-repo, no adversarial, no budgets
- **Phase 2:** Fable-5 orchestrator + Sonnet workers, still no adversarial
- **Phase 3:** Adversarial reviewer + 3-cycle loop
- **Phase 4:** Budgets, per-user PAT routing, Vercel logs integration
- **Phase 5:** Multi-user, more repos, better observability
- **Later:** Promote to full OpenClaw plugin marketplace listing

## Contributing

Not open for external contributions yet. When it stabilises, standard PR flow with CI.

## License

MIT. See [`LICENSE`](LICENSE).
