/**
 * beta.96 — the ZERO-FEEDBACK go-live blocker (session 1b267b86, 2026-08-01).
 *
 * The b95 smoke died in PLANNING (`loop.plan_failed: extractJson failed: no
 * JSON in output`) at $0.00 and Carel waited ~2h with NO outbound feedback.
 * Root cause: the loop posts phase-ENTRY but the TERMINAL post was fragile.
 * `setStatus("failed")` DOES fire the beta.77 native Slack poster
 * (`deliverProgress`), but that gated on `if (!buildProgressSnapshot().headline)
 * return`, and a plan-phase death had (a) an empty sub-task ledger and (b) a
 * `failureDetail` that only populated from `loop.*_verify_failed`/revise-spec
 * audits — NOT the generic `loop.failed`/`loop.plan_failed` {reason}. So the
 * headline was empty and the only signal of failure was silently dropped.
 *
 * b96 fixes it in three places:
 *   1. loop.ts finaliseFailed/finaliseFailedPreserveWorktree: audit the reason
 *      BEFORE setStatus (so the terminal post can read it).
 *   2. progress.ts buildHeadline: GENERIC-reason fallback — read
 *      loop.failed/loop.plan_failed {reason|err} when no verifier-path-fail
 *      event is present, so a plan_failed headline is never empty.
 *   3. index.ts deliverProgress: NEVER drop a TERMINAL post on an empty headline
 *      — build a minimal reason-bearing line from the audit reason instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let buildProgressSnapshot, Database;
try {
  ({ buildProgressSnapshot } = await import("../dist/orchestrator/progress.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  buildProgressSnapshot = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");
const loopSrc = readFileSync(resolve(here, "..", "src", "orchestrator", "loop.ts"), "utf8");
const indexSrc = readFileSync(resolve(here, "..", "src", "index.ts"), "utf8");
const progressSrc = readFileSync(resolve(here, "..", "src", "orchestrator", "progress.ts"), "utf8");

function makeDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}
function insertSession(db, id, over = {}) {
  const s = { status: "failed", repo: "o/r", branch: "harness/x", cycles_ran: 0, cost_usd: 0, budget_usd: 30, ...over };
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, pr_number, final_pr_url, deploy_status)
     VALUES (?, ?, '', 'U1', 'U1', ?, ?, '/tmp/wt', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, `agent:${id}`, s.repo, s.branch, s.status, Date.now(), Date.now(), s.budget_usd, s.cost_usd, s.cycles_ran);
}
function insertAudit(db, sessionId, event, payload = {}, atOffset = 0) {
  db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, event, JSON.stringify(payload), Date.now() + atOffset);
}

test("beta.96: version >= beta.96", () => {
  const betaNum = (v) => parseInt(/beta\.(\d+)/.exec(v)?.[1] ?? "0", 10);
  assert.ok(betaNum(JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")).version) >= 96);
});

// ---- behaviour: the 1b267b86 repro ----

test("beta.96: a plan_failed session (empty ledger) produces a NON-EMPTY, reason-bearing headline", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "planfail", { status: "failed", cycles_ran: 0, cost_usd: 0 });
  // NO sub-tasks (died in planning). Only the plan_failed reason audit exists.
  insertAudit(db, "planfail", "loop.plan_failed", { err: "extractJson failed: no JSON in output" }, 10);
  const snap = buildProgressSnapshot(db, "planfail");
  assert.ok(snap.headline && snap.headline.trim().length > 0, "headline must NOT be empty for a plan_failed");
  assert.match(snap.headline, /Failed/i);
  assert.match(snap.headline, /no JSON in output/, "the plan_failed reason must surface in the headline");
});

test("beta.96: loop.failed {reason} also surfaces (canonical terminal event)", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "lf", { status: "failed", cycles_ran: 1 });
  insertAudit(db, "lf", "loop.failed", { reason: "pr_error: 422 validation failed", cycles: 1 }, 10);
  const snap = buildProgressSnapshot(db, "lf");
  assert.ok(snap.headline && snap.headline.trim().length > 0);
  assert.match(snap.headline, /pr_error: 422/);
});

test("beta.96: a verifier-path-fail still takes precedence over the generic reason (b50 behaviour preserved)", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "vf", { status: "failed", cycles_ran: 2 });
  insertAudit(db, "vf", "loop.failed", { reason: "verify_failed", cycles: 2 }, 5);
  insertAudit(db, "vf", "loop.file_committed_verify_failed", { detail: "prisma/schema.prisma not committed" }, 10);
  const snap = buildProgressSnapshot(db, "vf");
  assert.match(snap.headline, /verifier path check: prisma\/schema\.prisma/, "specific verifier detail wins over generic reason");
});

test("beta.96: a non-terminal (executing) empty-ledger session does NOT get a fabricated failure reason", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "run", { status: "executing", cycles_ran: 1 });
  const snap = buildProgressSnapshot(db, "run");
  assert.doesNotMatch(snap.headline, /no JSON|pr_error|plan_failed/, "an active run must not surface a failure detail");
});

// ---- wiring source-asserts ----

test("beta.96: finaliseFailed audits the reason BEFORE setStatus", () => {
  // In the finaliseFailed body, the loop.failed audit must appear before setStatus("failed").
  const body = /private finaliseFailed\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(loopSrc)?.[1] ?? "";
  assert.ok(body.length > 0, "finaliseFailed body found");
  const auditIdx = body.indexOf('audit("loop.failed"');
  const setStatusIdx = body.indexOf('setStatus(sessionId, "failed")');
  assert.ok(auditIdx >= 0 && setStatusIdx >= 0, "both calls present");
  assert.ok(auditIdx < setStatusIdx, "loop.failed audit must precede setStatus so the terminal post can read the reason");
});

test("beta.96: finaliseFailedPreserveWorktree also audits before setStatus", () => {
  const body = /private finaliseFailedPreserveWorktree\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(loopSrc)?.[1] ?? "";
  assert.ok(body.length > 0, "finaliseFailedPreserveWorktree body found");
  const auditIdx = body.indexOf('audit("loop.failed"');
  const setStatusIdx = body.indexOf('setStatus(sessionId, "failed")');
  assert.ok(auditIdx >= 0 && setStatusIdx >= 0 && auditIdx < setStatusIdx, "reason audit precedes setStatus");
});

test("beta.96: deliverProgress never drops a TERMINAL post on an empty headline", () => {
  assert.ok(/if \(!headline && isTerminal\) headline = terminalFallbackHeadline\(/.test(indexSrc),
    "terminal empty-headline fallback wired");
  assert.ok(/const isTerminal = status === "done" \|\| status === "failed" \|\| status === "aborted"/.test(indexSrc),
    "isTerminal computed for the terminal-post guard");
  assert.ok(/function terminalFallbackHeadline\(db: DatabaseSync, sessionId: string, status: string\)/.test(indexSrc),
    "terminalFallbackHeadline helper defined");
});

test("beta.96: progress.ts has the generic loop.failed/plan_failed reason fallback", () => {
  assert.ok(/event IN \('loop\.failed','loop\.plan_failed'\)/.test(progressSrc),
    "generic-reason fallback queries loop.failed/plan_failed");
});
