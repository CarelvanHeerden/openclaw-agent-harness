# Example: minimal task walkthrough

This is the smoke test the harness targets for Phase 1.

## User posts in the dev Slack channel

```
harness: add a comment to README.md saying hello from the agent harness
```

## Expected timeline

1. **Thread starts.**
   Harness replies in-thread:
   > Got it. Target repo: `Stitch-Vercel/ProjectThanos`? Acceptance criteria: README.md contains a new comment line "hello from the agent harness"? Reply "go" or 🚀 to proceed.

2. **User confirms.** Reacts with 🚀 or replies "go".

3. **Crystallised prompt stored.** Session row created in `sessions`.

4. **Fable-5 lead plans.** One sub-task: "edit README.md at repo root, add a new commented line".

5. **Sonnet worker runs.** Opens README.md, adds `<!-- hello from the agent harness -->`, commits to branch `harness/hello-<timestamp>`.

6. **Adversarial review.** Fable-5 reads diff + spec. Verdict: `pass`.

7. **Push + PR.**
   - Branch pushed via requester's PAT.
   - Draft PR opened, title: "chore: hello from the agent harness".
   - PR description auto-populated from crystallised prompt + cost summary.

8. **Slack summary.**
   > ✅ Done. Duration: 1m22s. Cycles: 1. Cost: $0.14. PR: https://github.com/.../pull/N

## What this exercises

- Slack listener + intent classifier
- Crystallisation (single-turn, user says "go" fast path)
- SQLite state store
- PAT router (single user, single org)
- Sonnet worker with acceptEdits mode
- Adversarial reviewer
- Git branch + GitHub PR creation
- Cost tracking end-to-end

## What this does NOT exercise (yet)

- Multi-turn crystallisation
- Multi-worker plans
- Adversarial fixes_required loop
- Budget hit / override reactions
- Vercel logs bridge
- Repo creation on demand
- Multi-user PAT routing
