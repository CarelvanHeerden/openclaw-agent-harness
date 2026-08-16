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
// b127 headline. On b126 the run shipped a PR failing 2 of 8836 tests after
// four cycles and $18.78, because CI ran once, after the loop had already
// decided to finish. The question here is whether a red build got a cycle.
// ---------------------------------------------------------------------------
rule("1. CI REPAIR CYCLE  (the b127 headline)");
const ciGranted = of("loop.ci_repair_cycle_granted");
const ciDeclined = of("loop.ci_repair_declined");
const ciFail = of("loop.ci_failure");
const excerptMissing = /no log excerpt available/.test(String(session.merge_recommendation_reason ?? ""));

console.log(`   CI went red:            ${ciFail.length ? `YES (${ciFail.length}x)` : "no"}`);
console.log(`   repair cycles granted:  ${ciGranted.length}`);
if (ciGranted.length) {
  for (const g of ciGranted) console.log(`   - after cycle ${g.p.cycle}: ${trim(g.p.findings, 160)}`);
}
if (ciDeclined.length) {
  const d = ciDeclined.at(-1).p;
  console.log(`   repair declined:        ${d.reason} (granted ${d.granted} of ${d.ceiling}, spent $${d.spentUsd})`);
}
console.log(`   failing-log excerpt:    ${excerptMissing ? "MISSING" : "present"}`);

if (ciFail.length && excerptMissing) {
  console.log("   >>> VERDICT: the b127 log fix REGRESSED. CI went red and the PR still says");
  console.log("       '(no log excerpt available)'. Neither the check-runs output nor the Actions");
  console.log("       job log came back. Report the token's Actions: read permission.");
} else if (ciGranted.length && session.cycles_ran > (ciGranted.at(-1).p.cycle ?? 0)) {
  console.log("   >>> VERDICT: b127 WORKED. A red build was turned into blocking findings and the");
  console.log("       run spent another cycle on it. Check the final CI state below: if it went");
  console.log("       green, this is the whole feature paying for itself.");
} else if (ciGranted.length) {
  console.log("   >>> VERDICT: a repair cycle was GRANTED AND NOT RUN. That is the b124 failure");
  console.log("       shape repeating on a new counter. Report this — it is the important one.");
} else if (ciFail.length) {
  console.log("   >>> CI went red and no cycle was bought. Check the decline reason above: only");
  console.log("       'ceiling'/'budget'/'disabled' are expected. No decline line at all means the");
  console.log("       failing log could not be parsed into findings — report the excerpt.");
} else {
  console.log("   >>> CI never went red, so b127 was not exercised — that is fine, but it means");
  console.log("       this run did NOT test the repair path.");
}

// ---------------------------------------------------------------------------
// b126 headline. The b125 run never got past planning: the lead's reply was cut
// off mid-JSON, the harness called it prose, and the retry re-truncated at the
// same wall. Two questions here. Did the plan get cut off at all, and if so did
// the harness recognise it as a cut rather than as bad manners.
// ---------------------------------------------------------------------------
rule("2. PLANNER ATTEMPTS  (b126 truncation classifier, b128 syntax repair)");
const truncEv = of("loop.plan_truncated");
const planReady = of("loop.plan_ready");
const planFail = of("loop.plan_failed");
const failText = planFail.at(-1) ? JSON.stringify(planFail.at(-1).p) : "";
// b128: every attempt is audited now, win or lose. Before this the script could
// only see attempts that killed the run, so a truncation the retry RECOVERED
// from left no trace and section 2 printed "truncation detected: no" about a
// session whose container log said the opposite (f75f7db6). Read the ladder.
const attempts = of("lead.plan_attempt");
const attemptTruncated = attempts.filter((a) => a.p?.outcome === "truncated");
const attemptInvalid = attempts.filter((a) => a.p?.outcome === "invalid_json");
const sawTruncation = truncEv.length > 0 || attemptTruncated.length > 0;

if (attempts.length) {
  console.log(`   lead attempts:          ${attempts.length}`);
  for (const a of attempts) {
    const p = a.p ?? {};
    const rung = p.rung ? ` via ${p.rung}` : " (first attempt)";
    const cost = typeof p.costUsd === "number" ? `$${p.costUsd.toFixed(4)}` : "$?";
    console.log(`   - attempt ${p.attempt ?? "?"}: ${p.outcome ?? "?"}${rung}, ${p.outputChars ?? "?"} chars, ${cost}`);
    if (p.error) console.log(`       ${trim(p.error, 160)}`);
  }
} else {
  console.log("   lead attempts:          (not recorded — session predates b128)");
}

console.log(`   plan reached the loop:  ${planReady.length ? "YES" : "no"}`);
console.log(`   truncation detected:    ${sawTruncation ? `YES (${truncEv.length + attemptTruncated.length}x)` : "no"}`);
console.log(`   invalid JSON detected:  ${attemptInvalid.length ? `YES (${attemptInvalid.length}x)` : "no"}`);
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
} else if (attemptInvalid.length && planReady.length) {
  console.log("   >>> VERDICT: b128 WORKED. A reply came back COMPLETE but not valid JSON, the");
  console.log("       harness quoted the parse error back, and planning succeeded on the re-ask.");
} else if (attemptInvalid.length) {
  console.log("   >>> A reply was complete but would not parse, and planning still died. Check");
  console.log("       the attempt ladder above: if the syntax_repair rung never ran, either");
  console.log("       loop.lead_syntax_retry_enabled is false or the fault was not describable.");
} else if (sawTruncation && planReady.length) {
  console.log("   >>> VERDICT: b126 WORKED. A reply was cut off, the harness recognised it as a");
  console.log("       cut, retried with a smaller plan, and planning succeeded. This is the fix.");
} else if (planReady.length) {
  // b128: with the attempt ladder audited, "no truncation" is now a claim the
  // trail actually supports -- but only for sessions that HAVE the ladder. Keep
  // the caveat for older ones rather than reading their silence as success.
  console.log(
    attempts.length
      ? "   >>> Planning succeeded and every attempt is listed above, so this is a complete"
      : "   >>> A plan reached the loop and no truncation was recorded. This session predates",
  );
  console.log(
    attempts.length
      ? "       account of what the lead did — no inference required."
      : "       the b128 attempt ladder, so a retry that recovered would leave no trace here.",
  );
} else if (attempts.length) {
  console.log("   >>> No plan reached the loop. The attempt ladder above is the full account of");
  console.log("       what the lead tried; section 5 has the error that ended it.");
} else {
  console.log("   >>> No plan and no truncation recorded. See section 5 for what stopped it.");
}

// ---------------------------------------------------------------------------
// b125 headline. The check-runs API is closed to a fine-grained PAT and always
// will be; the question is whether the Actions fallback picked up the slack.
// ---------------------------------------------------------------------------
rule("3. CI SIGNAL PATH  (the b125 headline)");
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
  console.log("       See the TERMINAL CAUSE section for what stopped it first.");
} else if (viaWf.length) {
  // b127: the b126 report printed "workflow-runs fallback: FIRED" and then
  // "The Checks API answered normally" three lines below it. Both came off the
  // same events; the verdict branch only tested `denied`, so a fallback that
  // fired for any other reason fell through to the everything-is-fine text.
  console.log("   >>> The fallback fired WITHOUT a permanent denial — the Checks API was readable");
  console.log(`       and still had nothing for this sha (${trim(viaWf[0].p.reason, 120)}).`);
  console.log(`       It read ${viaWf[0].p.checkTotal} run(s). Zero runs means neither endpoint saw CI on this`);
  console.log("       commit, so any 'green' here is an absence of evidence, not evidence of");
  console.log("       passing. Check whether the workflow is triggered by this event at all.");
} else {
  console.log("   >>> The Checks API answered normally. b125 was not exercised — that is fine,");
  console.log("       but it means this run did NOT test the fallback.");
}

// ---------------------------------------------------------------------------
rule("4. CYCLE EXTENSION  (b124)");
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
rule("5. RESCUE -> RETRACTION PAIRING  (b123)");
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
rule("6. TERMINAL CAUSE");
const term = of("loop.failed", "loop.shipped", "loop.plan_failed").at(-1);
console.log(`   ${term ? `${term.event} ${trim(JSON.stringify(term.p), 400)}` : "(no terminal event recorded)"}`);
const verifyFails = events.filter((e) => e.event.endsWith("_verify_failed"));
if (verifyFails.length) {
  console.log(`   ${verifyFails.length} verification failure(s):`);
  for (const v of verifyFails.slice(0, 6)) console.log(`   - ${v.event} ${trim(JSON.stringify(v.p), 200)}`);
}

// ---------------------------------------------------------------------------
rule("7. SUB-TASKS");
const subs = db.prepare("SELECT cycle, seq, status, cost_usd, commit_sha, description FROM sub_tasks WHERE session_id = ? ORDER BY cycle, seq").all(session.id);
for (const s of subs) {
  console.log(`   c${s.cycle} #${s.seq} ${String(s.status).padEnd(11)} ${money(s.cost_usd).padStart(7)} ${(s.commit_sha || "").slice(0, 8).padEnd(9)} ${trim(s.description, 70)}`);
}
const failed = subs.filter((s) => s.status === "failed");
console.log(`   ${subs.length} sub-task(s), ${failed.length} failed`);

// ---------------------------------------------------------------------------
rule("8. TIME AND MONEY");
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

// b127 (#157). The lead's spend never reached the ledger, so every session
// cost the harness has ever reported was a lower bound by the price of the
// most expensive model in the run. On the b126 smoke that was 311 seconds of
// Opus reported as $0.00.
// b128 (#157, second half): b127 recorded the lead's cost only when planning
// SUCCEEDED, and only in memory. A run that died in planning still reported
// $0.00 (f75f7db6: two Opus calls, ten minutes, nothing on the ledger), and
// even a good run left the lead out of sessions.cost_usd. Read both paths.
const failedPlanCost = of("loop.plan_failed_cost").at(-1)?.p?.costUsd;
const leadCost = of("loop.plan_ready").at(-1)?.p?.leadCostUsd ?? failedPlanCost;
const attemptCost = attempts.reduce((sum, a) => sum + (Number(a.p?.costUsd) || 0), 0);
if (attempts.length) {
  console.log(`   lead attempts cost: $${attemptCost.toFixed(2)} across ${attempts.length} attempt(s)`);
}
if (leadCost === undefined) {
  console.log(
    attemptCost > 0
      ? "   lead planning cost: NOT BANKED — attempts cost real money (above) but neither"
      : "   lead planning cost: NOT RECORDED — the #157 fix is missing from this build.",
  );
  if (attemptCost > 0) {
    console.log("       plan_ready nor plan_failed_cost recorded it. The session total is short");
    console.log("       by that amount. This is the #157 defect, still open.");
  }
} else if (failedPlanCost !== undefined && !of("loop.plan_ready").length) {
  console.log(`   lead planning cost: $${Number(leadCost).toFixed(2)} — banked on a FAILED plan (b128).`);
  console.log("       Planning died, so this bought nothing, but it is real spend and the");
  console.log("       session total must show it. Pre-b128 this read $0.00.");
} else {
  console.log(`   lead planning cost: $${Number(leadCost).toFixed(2)} of the ${money(session.cost_usd)} total`);
  // b128: the planner cannot have spent more than the session did. If it reads
  // that way the lead's cost never reached sessions.cost_usd -- which is the
  // exact defect this release closed, so say so rather than printing the
  // contradiction straight-faced.
  if (Number(leadCost) > Number(session.cost_usd ?? 0) + 1e-6) {
    console.log("   >>> The planner cost MORE than the session total, which cannot be true. The");
    console.log("       lead's spend is not reaching sessions.cost_usd. Report this: it is the");
    console.log("       #157 defect back again.");
  }
  if (Number(leadCost) === 0) {
    console.log("   >>> The planner reported $0.00. If planning took more than a minute on Opus");
    console.log("       that is still wrong, and #157 is only half fixed. Report the duration.");
  }
}
console.log("");
