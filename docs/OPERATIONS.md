# Operations

Day-to-day and maintenance work for a running harness.

## Retention pruning

The audit log is append-only. Prune once a day.

### Programmatic

```ts
import { pruneRetention } from "openclaw-agent-harness/dist/state/retention.js";
import { openStateStore } from "openclaw-agent-harness/dist/state/store.js";

const store = await openStateStore("~/.openclaw/workspace/openclaw-agent-harness/state.db");
const result = pruneRetention(store, {
  auditRetentionDays: 90,
  pruneTerminalSessions: false,
});
console.log(result);
store.close();
```

### As an OpenClaw cron

Add to `openclaw.json`:

```json
{
  "crons": {
    "openclaw-agent-harness.retention": {
      "schedule": "5 3 * * *",
      "prompt": "Run harness retention prune. Invoke the harness_retention_prune tool with { auditRetentionDays: 90 } and post the result to the audit log.",
      "model": "sonnet",
      "channel": null
    }
  }
}
```

## Backups

The state DB is small (KB-MB range). Backup with `sqlite3 state.db .backup /path/to/backup.db` daily. If you use OpenClaw's memory backup cron, add this file to the manifest.

## Session recovery

If the container is restarted mid-session:

1. On next boot, the harness scans `sessions` for non-terminal rows:
   `crystallising`, `planning`, `executing`, `reviewing` and `resumable`.
2. **Fresh sessions are auto-resumed.** In tool-driven mode there is no reaction
   poller and no Slack listener, so nothing would ever act on a "resume?" prompt —
   a session parked awaiting confirmation would simply go quiet forever. Recovery
   therefore re-drives the loop itself rather than asking.
3. Only **stale** sessions — past the heartbeat threshold — are marked
   `interrupted` and surfaced for a human. Resume those deliberately with
   `harness_resume`.
4. Resuming uses `sessions.last_worker_sdk_session` (written at every checkpoint)
   to continue the last worker via the SDK's `resume()`.
5. If no per-worker session exists (interrupted during planning), the harness
   resumes from the crystallised prompt with the Fable-5 lead replay path.

## Cost forensics

To investigate a cost spike:

```sql
-- Top 20 most expensive sessions this month
SELECT id, requester, repo, cost_usd, cycles_ran, created_at
FROM sessions
WHERE created_at > strftime('%s','now','start of month') * 1000
ORDER BY cost_usd DESC
LIMIT 20;

-- Per-user monthly spend
SELECT month, user, spent_usd FROM budgets_monthly ORDER BY month DESC, spent_usd DESC;

-- Audit log for a session
SELECT event, payload, datetime(created_at/1000, 'unixepoch') AS ts
FROM audit_log WHERE session_id = ? ORDER BY id ASC;
```

## PAT cache lifecycle

At session start the harness fetches each required PAT from its own credential vault (`CredentialVault`, via `CredentialAdapter`) and caches it in-process (a plain `Map`, per-runtime, not persisted). Cached tokens live for the lifetime of the session and are dropped by `teardown()` when the session terminates.

Implication for long-running sessions: **there is no TTL**. If a PAT is rotated in the vault mid-session, the cached value continues to be used until the session ends. For rotations that must take effect on an active session, either:

- End the session (`harness_cancel`) so `teardown()` purges the cache, then start a new one; or
- Call `creds.drop(<service>)` programmatically from the runtime to force a re-fetch on next use.

Tokens are never persisted to disk by the credentials adapter, never written to `.git/config`, and never appear in the process argv (git operations use short-lived `x-access-token` URLs).

## Troubleshooting

- **PAT push rejected with 403 (SAML)**: the org enforces SAML SSO. Authorise the PAT in the org's PAT settings, then retry. Alternative: emit `git format-patch` to a workspace directory and apply locally (see MEMORY.md).
- **Vercel logs empty**: preview deploy has not landed yet. Adversary receives an explicit "NO RUNTIME DATA" banner and will not sign off on runtime concerns. Wait or increase `previewWaitSeconds`.
- **Session stuck in `crystallising`**: user never replied. Manually mark `aborted` in `sessions` or let the harness time out (default 24h).
- **Budget refuses new session**: check `budgets_monthly` for the user. Override with a `moneybag` reaction (audit-logged) or bump the config cap.
