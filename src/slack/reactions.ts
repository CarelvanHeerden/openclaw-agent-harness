/**
 * Slack reaction reader.
 *
 * The orchestrator loop polls this on every checkpoint to decide whether
 * to short-circuit (ship_it, abort) or extend budget (budget_bump). Reads
 * are cheap (a single `conversations.replies` + a `reactions.get` on the
 * origin message).
 *
 * Only reactions from `slack.authorised_users` count. This prevents a
 * random channel visitor from aborting an in-flight session.
 */

import type { HarnessConfig } from "../config.js";
import type { StateStore } from "../state/store.js";

export interface ReactionSnapshot {
  shipIt: boolean;
  abort: boolean;
  pause: boolean;
  budgetBump: boolean;
}

export interface ReactionsDeps {
  config: HarnessConfig;
  state: StateStore;
  slackToken: string;
  fetchImpl?: typeof fetch;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

interface ReactionsGetResponse {
  ok: boolean;
  message?: {
    reactions?: Array<{ name: string; users: string[] }>;
  };
  error?: string;
}

export class SlackReactionsReader {
  constructor(private readonly deps: ReactionsDeps) {}

  private fetchFn(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /**
   * Read reactions for `sessionId`. Aggregates the origin message + every
   * message the harness itself posted in the thread (those bot messages
   * are where users typically drop the `:rocket:` / `:x:`).
   */
  async read(sessionId: string): Promise<ReactionSnapshot> {
    const row = this.deps.state.db
      .prepare(`SELECT slack_channel, slack_thread FROM sessions WHERE id = ?`)
      .get(sessionId) as { slack_channel: string; slack_thread: string } | undefined;
    if (!row) {
      return { shipIt: false, abort: false, pause: false, budgetBump: false };
    }

    const messageTs = [row.slack_thread, ...(await this.threadReplyTimestamps(row.slack_channel, row.slack_thread))];
    const wanted = this.deps.config.slack.reactions;
    const authorised = new Set(this.deps.config.slack.authorised_users);
    const acc: ReactionSnapshot = { shipIt: false, abort: false, pause: false, budgetBump: false };

    for (const ts of messageTs) {
      const reactions = await this.reactionsForMessage(row.slack_channel, ts);
      for (const r of reactions) {
        const users = r.users.filter((u) => authorised.has(u));
        if (users.length === 0) continue;
        if (r.name === wanted.ship_it) acc.shipIt = true;
        else if (r.name === wanted.abort) acc.abort = true;
        else if (r.name === wanted.pause) acc.pause = true;
        else if (r.name === wanted.budget_bump) acc.budgetBump = true;
      }
    }
    return acc;
  }

  private async reactionsForMessage(channel: string, ts: string): Promise<Array<{ name: string; users: string[] }>> {
    const url = new URL("https://slack.com/api/reactions.get");
    url.searchParams.set("channel", channel);
    url.searchParams.set("timestamp", ts);
    url.searchParams.set("full", "true");
    const res = await this.fetchFn()(url.toString(), {
      headers: { Authorization: `Bearer ${this.deps.slackToken}` },
    });
    // 429 must propagate to the poller so it can back off globally.
    // Slack Web API also encodes rate_limited in the JSON body of a 200,
    // handle both shapes.
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      throw Object.assign(new Error(`slack 429 rate_limited (retry after ${retryAfter}s)`), { retryAfterSeconds: retryAfter });
    }
    if (!res.ok) {
      this.deps.logger.warn("[reactions] HTTP not ok", { status: res.status, ts });
      return [];
    }
    const j = (await res.json()) as ReactionsGetResponse & { retry_after?: number };
    if (!j.ok && j.error === "ratelimited") {
      throw Object.assign(new Error(`slack ratelimited (retry after ${j.retry_after ?? 60}s)`), { retryAfterSeconds: j.retry_after ?? 60 });
    }
    if (!j.ok) return [];
    return j.message?.reactions ?? [];
  }

  private async threadReplyTimestamps(channel: string, thread: string): Promise<string[]> {
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channel);
    url.searchParams.set("ts", thread);
    url.searchParams.set("limit", "100");
    try {
      const res = await this.fetchFn()(url.toString(), {
        headers: { Authorization: `Bearer ${this.deps.slackToken}` },
      });
      if (!res.ok) return [];
      const j = (await res.json()) as { ok: boolean; messages?: Array<{ ts: string; bot_id?: string; subtype?: string }> };
      if (!j.ok || !j.messages) return [];
      // Only bot-authored replies (that's where users drop reactions to signal us)
      return j.messages
        .filter((m) => m.bot_id || m.subtype === "bot_message")
        .map((m) => m.ts);
    } catch (err) {
      this.deps.logger.warn("[reactions] replies fetch failed", { err: String(err) });
      return [];
    }
  }
}
