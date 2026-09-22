import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync as Database} from 'node:sqlite';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const here=resolve(root,'tests');
const {registerHarnessTools}=await import(pathToFileURL(resolve(root,'dist/tools/registration.js')));
function makeRuntime({ riskLevel = "high", sessionDefaultUsd = 50, hardCeilingUsd } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const loopCalls = [];
  return {
    state: {
      db,
      isOpen: () => true,
      audit(event, payload, sessionId) { audits.push({ event, payload, sessionId }); },
      close() {},
    },
    audits,
    loopCalls,
    loop: { run: async (sessionId, brief) => { loopCalls.push({ sessionId, brief }); return { status: "shipped" }; } },
    crystallise: async () => ({
      kind: "brief",
      costUsd: 0,
      brief: {
        title: "Compliance calendar",
        motivation: "m",
        acceptanceCriteria: ["recurrence identities are stable across edits"],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel,
      },
    }),
    anthropicApiKey: async () => "sk-test",
    githubServiceFor: () => "github-o",
    githubToken: async () => "gh",
    gitResolutionFor: () => ({ credentialService: "github-o", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" }),
    gitToken: async () => "gh",
    budget: { getDailySpend: () => 0 },
    config: {
      storage: { audit_retention_days: 90 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
      pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}", auth: { api_key_env: "GH_TOKEN" } },
      budgets: { session_default_usd: sessionDefaultUsd, ...(hardCeilingUsd ? { session_hard_ceiling_usd: hardCeilingUsd } : {}) },
      loop: { session_hard_timeout_seconds: 18000 },
    },
  };
}

function collectTools() {
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: (definition) => {
      const def = typeof definition === "function" ? definition({ requesterSenderId: "U1", senderIsOwner: false }) : definition;
      tools.set(def.name, { ...def, execute: (input) => def.execute("test-call-id", input) });
      return () => tools.delete(def.name);
    },
  };
  return { api, tools };
}

async function pausedSession(runtime) {
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "build a tenant-safe compliance calendar" });
  assert.equal(r.details.awaitingConfirmation, true, "the gate must be the thing under test");
  return { tools, sessionId: r.details.sessionId };
}


async function gate(t) {
 const runtime=makeRuntime({sessionDefaultUsd:40});
 t.after(()=>runtime.state.db.close());
 const {tools,sessionId}=await pausedSession(runtime);
 const answer=(text,extra={})=>tools.get('harness_answer').execute({sessionId,answer:text,answeredBy:'human',invokedBy:'U1',clarificationSeq:-2,...extra});
 const row=()=>runtime.state.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
 const snapshot=()=>{const r=row();return {brief:r.crystallised_prompt,budget:r.budget_usd,timeout:r.hard_timeout_seconds};};
 const propose=async(text='Use performedAt, budget $50, 5 hours')=>{
  const result=await answer('revise brief: '+text);
  assert.equal(result.details.briefProposed,true);
  return result.content[0].text.match(/confirm brief [a-f0-9]{64}/)[0];
 };
 return {runtime,answer,row,snapshot,propose};
}

for(const text of [
 'Not approved.', 'No.', 'Only start after I approve.', 'Subject to my approval.',
 'Please continue\n$50 budget\n5 hours\nOnly start after I approve.',
 'Please continue\n$50 budget\n5 hours\nSubject to my approval.',
 'Please continue\n$50 budget\n5 hours\nStart only after I approve.',
 'Please continue\n$50 budget\n5 hours\nUse performedAt',
 'confirm, but use performedAt', 'We can discuss this tomorrow.', '$50 budget\n5 hours',
]) test('rc13 brief approval: no dispatch for '+text,async t=>{
 const g=await gate(t);const before=g.snapshot();
 const r=await g.answer(text);
 assert.equal(r.details.started,false);
 assert.equal(g.row().status,'awaiting_clarification');
 assert.equal(g.row().clarification_answer,null);
 assert.deepEqual(g.snapshot(),before);
 assert.equal(g.runtime.loopCalls.length,0);
});

test('rc13 brief proposal: exact stored correction/limits apply once, after review',async t=>{
 const g=await gate(t);const before=g.snapshot();const confirmation=await g.propose();
 assert.deepEqual(g.snapshot(),before);assert.equal(g.runtime.loopCalls.length,0);
 const stored=JSON.parse(g.row().clarification_subtask).briefProposal;
 assert.equal(stored.budgetUsd,50);assert.equal(stored.hardTimeoutSeconds,18000);
 assert.match(g.row().clarification_question,/Use performedAt/);
 assert.match(g.row().clarification_question,/recurrence identities are stable/);
 const fullQuestion=g.row().clarification_question;
 for(const wrong of ['confirm', 'confirm brief '+ '0'.repeat(64),confirmation+' but not yet']) {
  const result=await g.answer(wrong);assert.equal(result.details.started,false);
  assert.deepEqual(g.snapshot(),before);assert.equal(g.runtime.loopCalls.length,0);
  assert.equal(g.row().clarification_question,fullQuestion,'proposal remains available to read');
 }
 const result=await g.answer(confirmation);
 assert.equal(result.details.briefConfirmed,true);assert.equal(g.row().status,'planning');
 assert.equal(g.row().budget_usd,50);assert.equal(g.row().hard_timeout_seconds,18000);
 assert.deepEqual(JSON.parse(g.row().crystallised_prompt),stored.brief);
 assert.equal(g.runtime.loopCalls.length,1);
 await g.answer(confirmation);assert.equal(g.runtime.loopCalls.length,1);
});

test('rc13 brief proposal: replacement rejects stale confirmation',async t=>{
 const g=await gate(t);const old=await g.propose();const current=await g.propose('Use completedAt');
 assert.notEqual(current,old);assert.equal((await g.answer(old)).details.started,false);
 assert.equal(g.runtime.loopCalls.length,0);
 await g.answer(current);assert.equal(g.runtime.loopCalls.length,1);
 const b=g.runtime.loopCalls[0].brief;assert.match(JSON.stringify(b),/completedAt/);assert.doesNotMatch(JSON.stringify(b),/performedAt/);
});

test('rc13 brief proposal: a fresh tool registration resumes only the persisted proposal',async t=>{
 const g=await gate(t);const key=await g.propose();
 const fresh=collectTools();registerHarnessTools(fresh.api,g.runtime);
 const r=await fresh.tools.get('harness_answer').execute({sessionId:g.row().id,answer:key,answeredBy:'human',invokedBy:'U1',clarificationSeq:-2});
 assert.equal(r.details.briefConfirmed,true);assert.equal(g.runtime.loopCalls.length,1);
});

for(const change of ['proposal','base','limits','ceiling','session']) test('rc13 brief proposal: altered '+change+' invalidates confirmation',async t=>{
 const g=await gate(t);const key=await g.propose();
 if(change==='proposal'||change==='session') {
  const marker=JSON.parse(g.row().clarification_subtask);
  if(change==='session') marker.briefProposal.sessionId='other-session';
  else marker.briefProposal.brief.acceptanceCriteria.push('unreviewed');
  g.runtime.state.db.prepare('UPDATE sessions SET clarification_subtask=?').run(JSON.stringify(marker));
 } else if(change==='base') {
  const b=JSON.parse(g.row().crystallised_prompt);b.outOfScope.push('new restriction');
  g.runtime.state.db.prepare('UPDATE sessions SET crystallised_prompt=?').run(JSON.stringify(b));
 } else if(change==='limits') g.runtime.state.db.exec('UPDATE sessions SET budget_usd=45');
 else g.runtime.config.budgets.session_hard_ceiling_usd=45;
 const before=g.snapshot();assert.equal((await g.answer(key)).details.started,false);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.runtime.loopCalls.length,0);
});

test('rc13 brief proposal: activation rollback leaves exact proposal answerable',async t=>{
 const g=await gate(t);const key=await g.propose();const before=g.snapshot();
 g.runtime.state.db.exec("CREATE TRIGGER deny_activation BEFORE UPDATE OF hard_timeout_seconds ON sessions BEGIN SELECT RAISE(ABORT,'test fault'); END");
 const result=await g.answer(key);assert.equal(result.details.atomicApplyFailed,true);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.row().status,'awaiting_clarification');
 assert.equal(g.row().clarification_answer,null);assert.equal(g.runtime.loopCalls.length,0);
 g.runtime.state.db.exec('DROP TRIGGER deny_activation');
 await g.answer(key);assert.equal(g.runtime.loopCalls.length,1);
});

test('rc13 brief proposal: delegated automation cannot approve or stage',async t=>{
 const g=await gate(t);g.runtime.config.loop.clarification_auto_accept_delegated=true;
 const key=await g.propose();
 for(const reply of ['confirm',key,'revise brief: Use otherField']) {
  const r=await g.answer(reply,{answeredBy:'automation',evidence:'test evidence'});
  assert.equal(r.details.briefApprovalNotDelegable,true);assert.equal(g.runtime.loopCalls.length,0);
 }
});

test('rc13 brief proposal: oversized proposals and failed staging never mutate the active brief',async t=>{
 const g=await gate(t);const before=g.snapshot();
 assert.equal((await g.answer('revise brief: '+'x'.repeat(8001))).details.proposalFailed,true);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.runtime.loopCalls.length,0);
 g.runtime.state.db.exec("CREATE TRIGGER deny_staging BEFORE UPDATE OF clarification_subtask ON sessions BEGIN SELECT RAISE(ABORT,'test fault'); END");
 assert.equal((await g.answer('revise brief: Use performedAt')).details.proposalFailed,true);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.row().clarification_answer,null);
});

test('rc13 brief proposal: a staging audit failure preserves the previous proposal',async t=>{
 const g=await gate(t);const key=await g.propose();const marker=g.row().clarification_subtask;const question=g.row().clarification_question;
 const audit=g.runtime.state.audit;
 g.runtime.state.audit=(event,...args)=>{if(event==='tool.answer_brief_proposed') throw new Error('test audit fault');return audit(event,...args);};
 assert.equal((await g.answer('revise brief: Use differentField')).details.proposalFailed,true);
 assert.equal(g.row().clarification_subtask,marker);assert.equal(g.row().clarification_question,question);
 assert.equal(g.runtime.loopCalls.length,0);
 g.runtime.state.audit=audit;
 await g.answer(key);assert.equal(g.runtime.loopCalls.length,1);
});

test('rc13 brief proposal: a gate replaced after the answer read cannot activate an old proposal',async t=>{
 const g=await gate(t);const key=await g.propose();const before=g.snapshot();
 const audit=g.runtime.state.audit;
 g.runtime.state.audit=(event,...args)=>{
  if(event==='loop.clarification_answered') {
   const marker=JSON.parse(g.row().clarification_subtask);marker.briefProposal.nonce='replacement';
   g.runtime.state.db.prepare('UPDATE sessions SET clarification_subtask=?').run(JSON.stringify(marker));
  }
  return audit(event,...args);
 };
 const r=await g.answer(key);
 assert.equal(r.details.atomicApplyFailed,true);assert.equal(g.runtime.loopCalls.length,0);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.row().status,'awaiting_clarification');
});

test('rc13 brief proposal: ignored activation write rolls back limits and preserves proposal',async t=>{
 const g=await gate(t);const key=await g.propose();const before=g.snapshot();const marker=g.row().clarification_subtask;
 g.runtime.state.db.exec("CREATE TRIGGER ignore_activation BEFORE UPDATE OF crystallised_prompt ON sessions BEGIN SELECT RAISE(IGNORE); END");
 assert.equal((await g.answer(key)).details.atomicApplyFailed,true);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.row().clarification_subtask,marker);assert.equal(g.runtime.loopCalls.length,0);
});

test('rc13 brief proposal: ignored staging write is reported as failure',async t=>{
 const g=await gate(t);const before=g.snapshot();const marker=g.row().clarification_subtask;
 g.runtime.state.db.exec("CREATE TRIGGER ignore_staging BEFORE UPDATE OF clarification_subtask ON sessions BEGIN SELECT RAISE(IGNORE); END");
 assert.equal((await g.answer('revise brief: Use performedAt')).details.proposalFailed,true);
 assert.deepEqual(g.snapshot(),before);assert.equal(g.row().clarification_subtask,marker);assert.equal(g.runtime.loopCalls.length,0);
});
