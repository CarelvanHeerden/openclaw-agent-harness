/**
 * Slack channel listener.
 *
 * Watches the configured dev channel. On a message from an authorised user,
 * classifies intent and, if it looks like a dev task, kicks off the
 * crystallisation flow.
 *
 * Session isolation rule (Rule #1 - hard invariant):
 *   1 Slack thread = at most 1 harness session.
 *
 * Enforced by:
 *   - A UNIQUE index on sessions(slack_channel, slack_thread) in schema.sql.
 *   - The routeMessage() logic below: top-level channel posts always start a
 *     new thread; in-thread replies bind to the existing session for that
 *     thread and never spawn a second one.
 *
 * PHASE 0 SCAFFOLD. handle() body wired in phase 1.
 */
import type { HarnessConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { Dispatcher } from "./dispatcher.js";

export interface ListenerDeps {
  config: HarnessConfig;
  state: StateStore;
  dispatcher: Dispatcher;
  logger: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, meta?: unknown) => void;
  };
}

export interface SlackMessageEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

export type RouteDecision =
  | { kind: "ignore"; reason: string }
  | { kind: "start_new_session"; threadTs: string }
  | { kind: "continue_session"; sessionId: string; threadTs: string }
  | { kind: "reject_top_level_reply"; threadTs: string };

export class SlackChannelListener {
  constructor(private readonly deps: ListenerDeps) {}

  /**
   * Pure decision function. Given an inbound message + current DB state,
   * decides how to route it. Kept pure so it can be unit-tested without
   * mocking Slack, the SDK, or the DB.
   */
  routeMessage(evt: SlackMessageEvent): RouteDecision {
    // Ignore bot, edit, delete, join, leave events
    if (evt.bot_id) return { kind: "ignore", reason: "bot_message" };
    if (evt.subtype && evt.subtype !== "thread_broadcast") {
      return { kind: "ignore", reason: `subtype:${evt.subtype}` };
    }

    // Wrong channel
    if (evt.channel !== this.deps.config.slack.channel) {
      return { kind: "ignore", reason: "wrong_channel" };
    }

    // Non-allow-listed user
    if (!this.deps.config.slack.authorised_users.includes(evt.user)) {
      return { kind: "ignore", reason: "unauthorised_user" };
    }

    if (evt.thread_ts) {
      // Reply inside an existing thread. Bind to that thread's session (if any).
      const row = this.deps.state.db
        .prepare(
          `SELECT id, status FROM sessions WHERE slack_channel = ? AND slack_thread = ?`,
        )
        .get(evt.channel, evt.thread_ts) as
        | { id: string; status: string }
        | undefined;

      if (!row) {
        // In-thread message but no session yet: only valid if we're mid-
        // crystallisation. For now, be strict and ignore. Prevents accidental
        // "resurrecting" of an old thread.
        return { kind: "ignore", reason: "reply_in_thread_without_session" };
      }
      return {
        kind: "continue_session",
        sessionId: row.id,
        threadTs: evt.thread_ts,
      };
    }

    // Top-level channel post: always starts a fresh thread + fresh session.
    // The thread_ts becomes the message's own ts.
    return { kind: "start_new_session", threadTs: evt.ts };
  }

  async handle(evt: SlackMessageEvent): Promise<void> {
    const decision = this.routeMessage(evt);
    this.deps.logger.info("[slack-listener] route", { decision, ts: evt.ts });

    switch (decision.kind) {
      case "ignore":
        return;
      case "start_new_session":
        await this.deps.dispatcher.startNewSession(evt);
        return;
      case "continue_session":
        await this.deps.dispatcher.continueSession(decision.sessionId, evt);
        return;
      case "reject_top_level_reply":
        this.deps.logger.info("[slack-listener] reject_top_level_reply currently unused");
        return;
    }
  }
}
