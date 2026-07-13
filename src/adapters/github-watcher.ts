/**
 * GitHub PR-merged watcher.
 *
 * Runs on a timer. For every session with `final_pr_url` set and status
 * still 'done' (not yet marked shipped-and-closed), asks GitHub if the
 * PR has been merged / closed. When it has:
 *   - drops a Slack note in the session's thread
 *   - marks the session with a `pr_merged_at` timestamp (soft column;
 *     schema-forward-compatible, stored as JSON in reactions_json for
 *     now to avoid a migration on beta)
 *   - releases the worktree
 *
 * Cheap: `GET /repos/:owner/:repo/pulls/:number` is a single request per
 * open session, capped at the number of sessions in-flight. Slack rate
 * limits are the more constraining side; we back off to 5 minutes.
 */

import type { StateStore } from "../state/store.js";
import type { GitAdapter } from "./git-worktree.js";

export interface PrWatcherOptions {
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  git?: GitAdapter;
  slackNotify?: (channel: string, threadTs: string, text: string) => Promise<unknown>;
  /** Resolves the PAT service to use for a given repo + slack user. */
  resolveGhToken: (repo: string, slackUserId: string) => Promise<string>;
}

export class PrMergedWatcher {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly state: StateStore, private readonly opts: PrWatcherOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info(`[pr-watcher] starting (interval ${this.opts.intervalMs ?? 300_000}ms)`);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.opts.logger.info(`[pr-watcher] stopped`);
  }

  /** Public for tests: run one iteration. Returns number of sessions closed. */
  async pollOnce(): Promise<number> {
    const rows = this.state.db
      .prepare(
        `SELECT id, requester, repo, final_pr_url, slack_channel, slack_thread, worktree_path
         FROM sessions
         WHERE status = 'done' AND final_pr_url IS NOT NULL AND final_pr_url != ''
           AND pr_closed_at IS NULL`,
      )
      .all() as Array<{
        id: string;
        requester: string;
        repo: string;
        final_pr_url: string;
        slack_channel: string;
        slack_thread: string;
        worktree_path: string;
      }>;

    let closed = 0;
    for (const row of rows) {
      const info = parsePrUrl(row.final_pr_url);
      if (!info) continue;
      try {
        const ghToken = await this.opts.resolveGhToken(row.repo, row.requester);
        const state = await this.fetchPrState(info.owner, info.repo, info.number, ghToken);
        if (!state) continue;
        if (state.state === "closed" || state.merged) {
          await this.finalise(row, state);
          closed++;
        }
      } catch (err) {
        this.opts.logger.warn("[pr-watcher] poll failed", { err: String(err), sessionId: row.id });
      }
    }
    return closed;
  }

  private async fetchPrState(owner: string, repo: string, number: number, ghToken: string): Promise<{ state: "open" | "closed"; merged: boolean; mergedAt: string | null } | null> {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "openclaw-agent-harness/0.1",
      },
    });
    if (!res.ok) {
      this.opts.logger.warn("[pr-watcher] GH fetch failed", { status: res.status });
      return null;
    }
    const j = (await res.json()) as { state: "open" | "closed"; merged: boolean; merged_at: string | null };
    return { state: j.state, merged: j.merged, mergedAt: j.merged_at };
  }

  private async finalise(row: { id: string; slack_channel: string; slack_thread: string; final_pr_url: string; repo: string; worktree_path: string }, state: { state: string; merged: boolean; mergedAt: string | null }): Promise<void> {
    // Proper columns as of 2026-07-13. `reactions_json` no longer stores
    // PR lifecycle (that was a beta-era shortcut). See src/state/store.ts.
    const now = Date.now();
    const mergedAtMs = state.mergedAt ? (Date.parse(state.mergedAt) || null) : null;
    this.state.db.prepare(
      `UPDATE sessions
          SET pr_closed_at = ?,
              pr_merged    = ?,
              pr_merged_at = ?,
              updated_at   = ?
        WHERE id = ?`,
    ).run(now, state.merged ? 1 : 0, mergedAtMs, now, row.id);
    this.state.audit("pr-watcher.closed", { sessionId: row.id, merged: state.merged, mergedAt: state.mergedAt }, row.id);

    const text = state.merged
      ? `:white_check_mark: PR merged: ${row.final_pr_url}. Cleaning up.`
      : `:no_entry_sign: PR closed without merge: ${row.final_pr_url}.`;
    try {
      await this.opts.slackNotify?.(row.slack_channel, row.slack_thread, text);
    } catch (err) {
      this.opts.logger.warn("[pr-watcher] slack notify failed", { err: String(err), sessionId: row.id });
    }

    // Release the worktree
    if (this.opts.git && row.worktree_path) {
      try {
        await this.opts.git.release(row.id, row.repo);
      } catch (err) {
        this.opts.logger.warn("[pr-watcher] worktree release failed", { err: String(err), sessionId: row.id });
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
    } catch (err) {
      this.opts.logger.warn("[pr-watcher] tick failed", { err: String(err) });
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs ?? 300_000);
    }
  }
}

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]!) };
}
