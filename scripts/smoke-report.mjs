#!/usr/bin/env node
/**
 * Smoke-report reader.
 *
 * Three releases running, the post-smoke analysis has depended on a throwaway
 * script copied into the container and lost on the next restart. This is that
 * script, committed, so the b125 run and every run after it are read the same
 * way.
 *
 * It answers one question per release whose fix cannot be seen from the outside
 * -- a run can look identical in Slack whether or not the fix engaged -- plus
 * the standing "what actually killed it".
 *
 *   usage:  node scripts/smoke-report.mjs [path/to/state.db] [sessionId]
 *
 * With no arguments it reads the default state.db and reports the most recent
 * session. Pass a session id to pin one.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const DEFAULT_DB = `${homedir()}/.openclaw/workspace/openclaw-agent-harness/state.db`;
const dbPath = process.argv[2] && !process.argv[2].match(/^[0-9a-f-]{36}$/) ? process.argv[2] : DEFAULT_DB;
const pinnedSession = process.argv.find((a) => /^[0-9a-f-]{36}$/.test(a));

if (!existsSync(dbPath)) {
  console.error(`no state.db at ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const rule = (t) => console.log(`\n${"=".repeat(78)}\n${t}`);
const dur = (ms) => `${(ms / 60000).toFixed(1)} min`;
const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const trim = (s, n = 150) => (s == null ? "" : String(s).replace(/\s+/g, " ").slice(0, n));

const session = pinnedSession
  ? db.prepare("SELECT * FROM sessions WHERE id = ?").get(pinnedSession)
  : db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1").get();

if (!session) {
  console.error("no sessions in the database");
  process.exit(1);
}

const events = db
  .prepare("SELECT event, payload, created_at FROM audit_log WHERE session_id = ? ORDER BY id")
  .all(session.id)
  .map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload); } catch { /* payload is not always json */ }
    return { ...r, p };
  });
const of = (...names) => events.filter((e) => names.includes(e.event));

// ---------------------------------------------------------------------------
rule(`SESSION    ${session.id}`);
console.log(`status     ${session.status} | cycles ${session.cycles_ran} | cost ${money(session.cost_usd)} of ${money(session.budget_usd)}`);
console.log(`branch     ${session.branch}`);
console.log(`repo       ${session.repo} | PR ${session.final_pr_url || "(none)"}`);
console.log(`wall clock ${dur(session.updated_at - session.created_at)}`);
console.log(`merge rec  ${session.merge_recommendation || "(none)"} ${trim(session.merge_recommendation_reason, 200)}`);

// ---------------------------------------------------------------------------
// b126 headline. The b125 run never got past planning: the lead's reply was cut
// off mid-JSON, the harness called it prose, and the retry re-truncated at the
// same wall. Two questions here. Did the plan get cut off at all, and if so did
// the harness recognise it as a cut rather than as bad manners.
// ---------------------------------------------------------------------------
rule("1. PLANNER TRUNCATION  (the b126 headline)");
const truncEv = of("loop.plan_truncated");
const planReady = of("loop.plan_ready");
const planFail = of("loop.plan_failed");
const failText = planFail.at(-1) ? JSON.stringify(planFail.at(-1).p) : "";

console.log(`   plan reached the loop:  ${planReady.length ? "YES" : "no"}`);
console.log(`   truncation detected:    ${truncEv.length ? `YES (${truncEv.length}x)` : "no"}`);
if (truncEv.length) {
  for (const t of truncEv) {
    console.log(`   - ${t.p.outputChars ?? "?"} chars against a ${t.p.maxOutputTokens ?? "(unset)"}-token ceiling on ${t.p.model ?? "?"}`);
  }
  console.log("     Compare those two numbers. At the ceiling means the plan is too big for one");
  console.log("     reply and the compaction retry is the right answer. Well under it means");
  console.log("     something ended the stream early and the ceiling is a red herring. b125");
  console.log("     could not answer this because the size was never recorded.");
}

if (/model returned prose/.test(failText)) {
  console.log("   >>> VERDICT: b126 REGRESSED, or this really was prose. The run died with the");
  console.log("       'model returned prose / check tools: []' message. If the raw reply starts");
  console.log("       with '{' it is the b125 bug back again — report it with the raw text.");
} else if (/truncated JSON in output/.test(failText)) {
  console.log("   >>> VERDICT: b126 named the failure correctly (truncated, not prose) but the");
  console.log("       run still died in planning. The compaction retry was not enough. Report");
  console.log("       the output size above — the plan may be genuinely too large for one reply.");
} else if (truncEv.length && planReady.length) {
  console.log("   >>> VERDICT: b126 WORKED. A reply was cut off, the harness recognised it as a");
  console.log("       cut, retried with a smaller plan, and planning succeeded. This is the fix.");
} else if (planReady.length) {
  console.log("   >>> Planning succeeded first time, so b126 was not exercised — that is fine,");
  console.log("       but it means this run did NOT test the truncation path.");
} else {
  console.log("   >>> No plan and no truncation recorded. See section 5 for what stopped it.");
}

// ---------------------------------------------------------------------------
// b125 headline. The check-runs API is closed to a fine-grained PAT and always
// will be; the question is whether the Actions fallback picked up the slack.
// ---------------------------------------------------------------------------
rule("2. CI SIGNAL PATH  (the b125 headline)");
const denied = of("loop.ci_permanently_denied");
const viaWf = of("loop.ci_read_via_workflow_runs");
const greenWf = of("loop.ci_green_via_workflow_runs");
const ciEnd = of("loop.ci_success", "loop.ci_failure", "loop.ci_indeterminate", "loop.ci_none", "loop.ci_wait_timeout");
const polls = ciEnd.at(-1)?.p?.polls ?? "?";

console.log(`   check-runs denied:      ${denied.length ? `YES (${denied.length}x)` : "no"}`);
console.log(`   workflow-runs fallback: ${viaWf.length ? `FIRED — read ${viaWf[0].p.checkTotal} run(s)` : "did not fire"}`);
console.log(`   CI terminal:            ${ciEnd.at(-1)?.event ?? "(never reached CI)"} after ${polls} poll(s)`);
if (viaWf.length) console.log(`   fallback reason:        ${trim(viaWf[0].p.reason, 200)}`);
if (denied.length) console.log(`   denial remedy:          ${trim(denied.at(-1).p.denial, 220)}`);

if (denied.length && viaWf.length) {
  console.log("   >>> VERDICT: b125 WORKED. The Checks API was shut and the run still read CI.");
  if (greenWf.length) console.log("       The green is caveated as Actions-only. Confirm that caveat appears on the PR.");
} else if (denied.length && !viaWf.length) {
  console.log("   >>> VERDICT: b125 DID NOT ENGAGE. Denied, and no fallback. Most likely the token");
  console.log("       lacks `Actions: read`, or ci.workflow_runs_fallback is false. Report this.");
} else if (!ciEnd.length) {
  // Do not report on a gate that never ran. Saying "the Checks API answered
  // normally" about a run that died before opening a PR is the same species of
  // confident-and-wrong that this script exists to catch.
  console.log("   >>> The run never reached CI, so nothing here is a statement about the CI gate.");
  console.log("       See section 5 for what stopped it first.");
} else {
  console.log("   >>> The Checks API answered normally. b125 was not exercised — that is fine,");
  console.log("       but it means this run did NOT test the fallback.");
}

// ---------------------------------------------------------------------------
rule("3. CYCLE EXTENSION  (b124)");
const suggested = of("loop.max_cycles_extend_suggested");
const extended = of("loop.max_cycles_extended");
console.log(`   extension suggested: ${suggested.length}`);
console.log(`   extension granted:   ${extended.length}`);
console.log(`   cycles actually ran: ${session.cycles_ran}`);
if (extended.length && session.cycles_ran <= (extended[0].p?.maxCycles ?? 2)) {
  console.log("   >>> VERDICT: a cycle was granted and NOT run. The b124 fix regressed. Report this.");
} else if (extended.length) {
  console.log("   >>> VERDICT: granted and run. b124 holding.");
} else {
  console.log("   >>> No extension was granted, so b124 was not exercised this run.");
}

// ---------------------------------------------------------------------------
rule("4. RESCUE -> RETRACTION PAIRING  (b123)");
const rescues = of("loop.contract_auto_resolved", "loop.contract_path_basename_rescued");
const retractions = of("loop.subtask_failure_retracted");
console.log(`   rescues fired: ${rescues.length} | retractions: ${retractions.length}`);
for (const r of rescues) console.log(`   - ${r.event} seq=${r.p.seq ?? "?"} cycle=${r.p.cycle ?? "?"} ${trim(r.p.reason ?? r.p.detail, 120)}`);
if (rescues.length > retractions.length) {
  console.log(`   >>> VERDICT: ${rescues.length - retractions.length} rescue(s) WITHOUT a retraction. The b123 fix has a hole. Report this.`);
} else if (rescues.length) {
  console.log("   >>> VERDICT: every rescue retracted its failure. b123 holding.");
} else {
  console.log("   >>> No rescues fired, so b123 was not exercised this run.");
}

// ---------------------------------------------------------------------------
rule("5. TERMINAL CAUSE");
const term = of("loop.failed", "loop.shipped", "loop.plan_failed").at(-1);
console.log(`   ${term ? `${term.event} ${trim(JSON.stringify(term.p), 400)}` : "(no terminal event recorded)"}`);
const verifyFails = events.filter((e) => e.event.endsWith("_verify_failed"));
if (verifyFails.length) {
  console.log(`   ${verifyFails.length} verification failure(s):`);
  for (const v of verifyFails.slice(0, 6)) console.log(`   - ${v.event} ${trim(JSON.stringify(v.p), 200)}`);
}

// ---------------------------------------------------------------------------
rule("6. SUB-TASKS");
const subs = db.prepare("SELECT cycle, seq, status, cost_usd, commit_sha, description FROM sub_tasks WHERE session_id = ? ORDER BY cycle, seq").all(session.id);
for (const s of subs) {
  console.log(`   c${s.cycle} #${s.seq} ${String(s.status).padEnd(11)} ${money(s.cost_usd).padStart(7)} ${(s.commit_sha || "").slice(0, 8).padEnd(9)} ${trim(s.description, 70)}`);
}
const failed = subs.filter((s) => s.status === "failed");
console.log(`   ${subs.length} sub-task(s), ${failed.length} failed`);

// ---------------------------------------------------------------------------
rule("7. TIME AND MONEY");
const first = events[0]?.created_at ?? session.created_at;
const ciStart = of("loop.ci_poll_started")[0]?.created_at;
const ciDone = ciEnd.at(-1)?.created_at;
if (ciStart && ciDone) {
  const ciMs = ciDone - ciStart;
  const pct = ((ciMs / (session.updated_at - session.created_at)) * 100).toFixed(0);
  console.log(`   CI polling: ${dur(ciMs)} (${pct}% of wall clock)`);
  if (Number(pct) > 8) console.log("   >>> CI polling is eating the run. Report the percentage.");
}
console.log(`   first event to last: ${dur((events.at(-1)?.created_at ?? session.updated_at) - first)}`);
console.log("");
