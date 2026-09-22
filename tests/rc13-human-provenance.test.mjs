import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync as Database} from 'node:sqlite';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const here=resolve(root,'tests');
const {registerHarnessTools}=await import(pathToFileURL(resolve(root,'dist/tools/registration.js')));
const {openStateStoreSync}=await import(pathToFileURL(resolve(root,'dist/state/store.js')));

test('human provenance: branch-push CI runs the focused provenance mutation gate',()=>{
 const ci=readFileSync(resolve(root,'.github','workflows','ci.yml'),'utf8');
 assert.match(ci,/name: Provenance mutation check \(branch push\)/);
 assert.match(ci,/github\.event_name == 'push'/);
 assert.match(ci,/node scripts\/mutation-check\.mjs 'rc\.13 human provenance:'/, 'the exact-commit branch run must exercise all provenance mutations');
});
function makeRuntime({ riskLevel = "high", sessionDefaultUsd = 50, hardCeilingUsd, dbPath = ":memory:" } = {}) {
  const db = new Database(dbPath);
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


async function fixture(t, {commands = true, delegated = true, dbPath} = {}) {
 const runtime=makeRuntime({sessionDefaultUsd:40,dbPath}); runtime.config.loop.clarification_auto_accept_delegated=delegated;
 t.after(()=>runtime.state.db.close());
 const factories=new Map(); let command; const api={logger:{info(){},warn(){},error(){}},
 registerTool(def){factories.set(def.name,def);return()=>{};},
 ...(commands?{registerCommand(def){command=def;}}:{})};
 const dispose=registerHarnessTools(api,runtime);
 const run=factories.get('harness_run');
 const r=await run.execute('test',{requester:'U1',request:'build a tenant-safe compliance calendar'});
 const id=r.details.sessionId; assert.equal(r.details.awaitingConfirmation,true);
 const row=()=>runtime.state.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
 const invoke=(args,extra={})=>command.handler({senderId:'U1',channel:'slack',isAuthorizedSender:true,args,commandBody:'/harness-answer '+args,...extra});
 const challenge=async()=>{const r=await invoke(id);const m=r.text.match(/\/harness-answer (\S+) ([a-f0-9]{48})/);assert.ok(m,r.text);return m[2];};
 const human=async(answer)=>invoke(`${id} ${await challenge()} ${answer}`);
 const tool=(answer,extra={},context={requesterSenderId:'U1'})=>factories.get('harness_answer')(context).execute('agent',{sessionId:id,answer,invokedBy:'U1',answeredBy:'human',clarificationSeq:-2,...extra});
 return {runtime,id,row,invoke,challenge,human,tool,dispose,factories,registerAgain:()=>registerHarnessTools(api,runtime)};
}
function beforeNextStatementRun(db,match,before) {
 const prepare=db.prepare.bind(db);let armed=true;
 db.prepare=(sql)=>{
  const statement=prepare(sql);
  if(!armed||!match.test(sql))return statement;
  return new Proxy(statement,{get(target,property){
   if(property==='run')return(...args)=>{
    armed=false;db.prepare=prepare;before();return target.run(...args);
   };
   const value=Reflect.get(target,property,target);
   return typeof value==='function'?value.bind(target):value;
  }});
 };
}
for(const delegated of [false,true]) for(const text of ['confirm', 'confirm, budget $50, 5 hours', 'revise brief: Use performedAt'])
 test(`human provenance: spoofed human tool blocked (delegated=${delegated}, ${text})`,async t=>{
  const g=await fixture(t,{delegated});const before=g.row();const r=await g.tool(text);
  assert.equal(r.details.trustedHumanCommandRequired,true);assert.deepEqual(g.row(),before);assert.equal(g.runtime.loopCalls.length,0);
 });
test('human provenance: agent cannot confirm even a real pending proposal hash',async t=>{
 const g=await fixture(t);const p=await g.human('revise brief: Use performedAt, budget $50, 5 hours');
 assert.equal(p.details.briefProposed,true);const key=p.text.match(/confirm brief [a-f0-9]{64}/)[0];const before=g.row();
 for(const extra of [{},{answeredBy:'automation',evidence:'user said yes'},{trustedHuman:true,commandBody:key,messageId:'fake'}]) {
  const r=await g.tool(key,extra,{requesterSenderId:'U1',senderIsOwner:true,trustedHuman:true});
  assert.equal(r.details.ok,false);assert.deepEqual(g.row(),before);
 }
 const ok=await g.human(key);assert.equal(ok.details.ok,true);assert.equal(g.runtime.loopCalls.length,1);
 assert.equal(g.row().budget_usd,50);
});
test('human provenance: missing command API fails closed, including legacy direct execute',async t=>{
 const g=await fixture(t,{commands:false}); const before=g.row();
 assert.equal((await g.tool('confirm')).details.trustedHumanCommandRequired,true);
 const r=await g.factories.get('harness_answer').execute('legacy',{sessionId:g.id,answer:'confirm',invokedBy:'U1',answeredBy:'human'});
 assert.equal(r.details.ok,false);assert.deepEqual(g.row(),before);
});
test('human provenance: direct command is single-use under concurrent redelivery',async t=>{
 const g=await fixture(t);const c=await g.challenge(); const args=`${g.id} ${c} confirm, budget $50, 5 hours`;
 const results=await Promise.all([g.invoke(args),g.invoke(args)]);
 assert.equal(results.filter(r=>r.details?.ok).length,1);assert.equal(g.runtime.loopCalls.length,1);
 assert.match((await g.invoke(args)).text,/No pending|used/);
});
test('human provenance: failed or non-approval command consumes receipt too',async t=>{
 const g=await fixture(t);const c=await g.challenge();await g.invoke(`${g.id} ${c} Not approved.`);
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/used/);assert.equal(g.runtime.loopCalls.length,0);
});
for(const changes of [{senderId:'U2'},{senderId:undefined},{isAuthorizedSender:false},{channel:'discord'},{commandBody:'/harness-answer forged'}])
 test('human provenance: reject invalid host command context '+JSON.stringify(changes),async t=>{
  const g=await fixture(t);const c=await g.challenge();const before=g.row();await g.invoke(`${g.id} ${c} confirm`,changes);
  assert.deepEqual(g.row(),before);assert.equal(g.runtime.loopCalls.length,0);
 });
test('human provenance: expired and changed-state commands stay paused',async t=>{
 const g=await fixture(t);let c=await g.challenge();g.runtime.state.db.prepare('UPDATE human_answer_challenges SET expires_at=0 WHERE id=?').run(c);
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/expired/);
 c=await g.challenge();g.runtime.state.db.prepare('UPDATE sessions SET budget_usd=15 WHERE id=?').run(g.id);
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/stale/);assert.equal(g.runtime.loopCalls.length,0);
});
test('human provenance: receipt cannot cross session or sender',async t=>{
 const g=await fixture(t);const c=await g.challenge();g.runtime.config.slack.authorised_users.push('U2');
 assert.match((await g.invoke(`${g.id} ${c} confirm`,{senderId:'U2'})).text,/owned/);
 assert.match((await g.invoke(`another-session ${c} confirm`)).text,/owned/);assert.equal(g.runtime.loopCalls.length,0);
});
test('human provenance: no handler use after disposal',async t=>{
 const g=await fixture(t);const c=await g.challenge();g.dispose();assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/Unauthorised/);assert.equal(g.runtime.loopCalls.length,0);
});
test('human provenance: oversized or sanitized command cannot drop restrictions',async t=>{
 const g=await fixture(t);const c=await g.challenge();const args=`${g.id} ${c} confirm`;
 await g.invoke(args,{commandBody:'/harness-answer '+args+' '+ 'x'.repeat(4000)+' DO NOT START'});
 assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: a realistic oversized lead plan no longer deadlocks review',async t=>{
 const g=await fixture(t);
 const paused={seq:7,title:'Repair tenant-safe recurrence',intent:'Preserve recurrence identity and tenant boundaries'};
 const plan={title:'large plan',subTasks:Array.from({length:180},(_,i)=>({
  seq:i,title:`Task ${i}`,intent:`${i}:`+'x'.repeat(220),filesLikelyTouched:[`src/${i}.ts`],acceptanceCriteria:['verified'],
 }))};
 plan.subTasks[7]=paused;
 g.runtime.state.db.prepare(`UPDATE sessions SET lead_plan_json=?, clarification_seq=7,
   clarification_subtask=?, clarification_question=? WHERE id=?`).run(
    JSON.stringify(plan),JSON.stringify({task:paused}),'May this exact repair continue?',g.id);
 const review=await g.invoke(g.id);
 assert.doesNotMatch(review.text,/too large|shorten the brief/i);
 assert.match(review.text,/May this exact repair continue/);
 assert.match(review.text,/Repair tenant-safe recurrence/);
 assert.match(review.text,/full_plan_sha256/);
 assert.match(review.text,/omitted_unrelated_subtasks/);
 const challenge=review.text.match(/\/harness-answer \S+ ([a-f0-9]{48})/)[1];
 g.runtime.state.db.prepare('UPDATE sessions SET lead_plan_json=? WHERE id=?').run(
  JSON.stringify({...plan,title:'changed after review'}),g.id);
 assert.match((await g.invoke(`${g.id} ${challenge} accept`)).text,/stale/);
 assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: recovery outcome and normalized listener liveness are state-bound',async t=>{
 for(const [column,value] of [['final_pr_url','https://example.test/pr/1'],['pr_number',42],['branch','harness/changed'],['cost_usd',12.34]]) {
  const g=await fixture(t);const c=await g.challenge();
  g.runtime.state.db.prepare(`UPDATE sessions SET ${column}=? WHERE id=?`).run(value,g.id);
  assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/stale/,column);
  assert.equal(g.runtime.loopCalls.length,0);
 }
 const g=await fixture(t);
 g.runtime.state.db.prepare('UPDATE sessions SET clarification_heartbeat_at=? WHERE id=?').run(Date.now(),g.id);
 const c=await g.challenge();
 g.runtime.state.db.prepare('UPDATE sessions SET clarification_heartbeat_at=? WHERE id=?').run(Date.now()+1000,g.id);
 const accepted=await g.invoke(`${g.id} ${c} confirm`);
 assert.equal(accepted.details.ok,true,'routine live heartbeat movement does not stale the receipt');
 const h=await fixture(t);
 h.runtime.state.db.prepare('UPDATE sessions SET clarification_heartbeat_at=? WHERE id=?').run(Date.now(),h.id);
 const hc=await h.challenge();
 h.runtime.state.db.prepare('UPDATE sessions SET clarification_heartbeat_at=0 WHERE id=?').run(h.id);
 assert.match((await h.invoke(`${h.id} ${hc} confirm`)).text,/stale/,'a liveness outcome change invalidates the receipt');
});

test('human provenance: large decision review is paginated and every page is required',async t=>{
 const g=await fixture(t);
 g.runtime.state.db.prepare('UPDATE sessions SET clarification_question=? WHERE id=?').run(
  `Review this complete constraint set:\n${'constraint '.repeat(4200)}`,g.id);
 const first=await g.invoke(g.id);
 const header=first.text.match(/page 1\/(\d+)/);assert.ok(header,first.text);
 const pageCount=Number(header[1]);assert.ok(pageCount>1);
 const challenge=first.text.match(/\/harness-answer \S+ ([a-f0-9]{48})/)[1];
 assert.match((await g.invoke(`${g.id} ${challenge} confirm`)).text,/Review incomplete/);
 assert.equal(g.runtime.loopCalls.length,0);
 if(pageCount>2) assert.match((await g.invoke(`${g.id} ${challenge} review 3`)).text,/in order/);
 for(let page=2;page<=pageCount;page++) {
  const response=await g.invoke(`${g.id} ${challenge} review ${page}`);
  assert.match(response.text,new RegExp(`page ${page}/${pageCount}`));
 }
 const accepted=await g.invoke(`${g.id} ${challenge} confirm`);
 assert.equal(accepted.details.ok,true);
 assert.equal(g.runtime.loopCalls.length,1);
});

test('human provenance: final claim atomically rechecks that every page was reviewed',async t=>{
 const g=await fixture(t);
 g.runtime.state.db.prepare('UPDATE sessions SET clarification_question=? WHERE id=?').run(
  `Review this complete constraint set:\n${'constraint '.repeat(4200)}`,g.id);
 const first=await g.invoke(g.id);const pageCount=Number(first.text.match(/page 1\/(\d+)/)?.[1]);
 assert.ok(pageCount>1,first.text);
 const challenge=first.text.match(/\/harness-answer \S+ ([a-f0-9]{48})/)[1];
 for(let page=2;page<=pageCount;page++)await g.invoke(`${g.id} ${challenge} review ${page}`);
 beforeNextStatementRun(g.runtime.state.db,/UPDATE human_answer_challenges SET consumed_at/,
  ()=>g.runtime.state.db.prepare('UPDATE human_answer_challenges SET reviewed_through=? WHERE id=?').run(pageCount-1,challenge));
 assert.match((await g.invoke(`${g.id} ${challenge} confirm`)).text,/stale|changed/);
 assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: review-page advancement compare-and-swaps the prior page',async t=>{
 const g=await fixture(t);
 g.runtime.state.db.prepare('UPDATE sessions SET clarification_question=? WHERE id=?').run(
  `Review this complete constraint set:\n${'constraint '.repeat(4200)}`,g.id);
 const first=await g.invoke(g.id);const pageCount=Number(first.text.match(/page 1\/(\d+)/)?.[1]);
 assert.ok(pageCount>1,first.text);
 const challenge=first.text.match(/\/harness-answer \S+ ([a-f0-9]{48})/)[1];
 beforeNextStatementRun(g.runtime.state.db,/UPDATE human_answer_challenges SET reviewed_through/,
  ()=>g.runtime.state.db.prepare('UPDATE human_answer_challenges SET reviewed_through=2 WHERE id=?').run(challenge));
 assert.match((await g.invoke(`${g.id} ${challenge} review 2`)).text,/changed while reviewing/);
 assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: existing receipt tables migrate without losing rows',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(resolve(tmpdir(),'human-receipt-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=resolve(dir,'state.db');const legacy=new Database(path);
 legacy.exec(`CREATE TABLE human_answer_challenges (
   id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sender TEXT NOT NULL,
   state_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
 )`);
 legacy.prepare(`INSERT INTO human_answer_challenges
   (id,session_id,sender,state_hash,expires_at,consumed_at) VALUES (?,?,?,?,?,NULL)`)
   .run('legacy','S','U1','hash',9999999999999);legacy.close();
 const store=openStateStoreSync(path);t.after(()=>store.close());
 const row=store.db.prepare(`SELECT id,review_page_count,reviewed_through
   FROM human_answer_challenges WHERE id='legacy'`).get();
 assert.deepEqual({...row},{id:'legacy',review_page_count:1,reviewed_through:1});
});

test('human provenance: changed state after receipt consumption cannot dispatch or abort',async t=>{
 for(const answer of ['confirm','abort']) {
  const g=await fixture(t);const c=await g.challenge();const original=g.runtime.state.audit;
  g.runtime.state.audit=(event,...args)=>{ if(event==='command.human_answer_consumed')g.runtime.state.db.prepare('UPDATE sessions SET budget_usd=99 WHERE id=?').run(g.id);return original(event,...args);};
  const r=await g.invoke(`${g.id} ${c} ${answer}`);assert.equal(r.details.staleHumanApproval,true);
  assert.equal(g.row().status,'awaiting_clarification');assert.equal(g.runtime.loopCalls.length,0);
 }
});
test('human provenance: changed state across async storage validation is rejected',async t=>{
 const g=await fixture(t);const c=await g.challenge();const pending=g.invoke(`${g.id} ${c} confirm`);
 g.runtime.state.db.prepare('UPDATE sessions SET budget_usd=99 WHERE id=?').run(g.id);
 const r=await pending;assert.equal(r.details.staleHumanApproval,true);assert.equal(g.runtime.loopCalls.length,0);
});
test('human provenance: durable used receipt survives database reopen and re-registration',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(resolve(tmpdir(),'human-receipt-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=resolve(dir,'state.db');const g=await fixture(t,{dbPath:path});const c=await g.challenge();
 await g.invoke(`${g.id} ${c} Not approved.`);g.runtime.state.db.close();g.runtime.state.db=new Database(path);g.registerAgain();
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/used/);assert.equal(g.runtime.loopCalls.length,0);
});
test('human provenance: ignored receipt claim cannot dispatch',async t=>{
 const g=await fixture(t);const c=await g.challenge();
 g.runtime.state.db.exec('CREATE TRIGGER ignore_receipt BEFORE UPDATE ON human_answer_challenges BEGIN SELECT RAISE(IGNORE); END');
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/used/);assert.equal(g.runtime.loopCalls.length,0);
});
test('human provenance: failed audit consumes receipt but never dispatches',async t=>{
 const g=await fixture(t);const c=await g.challenge();g.runtime.state.audit=()=>{throw Error('audit failed');};
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/failed/);
 assert.match((await g.invoke(`${g.id} ${c} confirm`)).text,/used/);assert.equal(g.runtime.loopCalls.length,0);
});

for(const status of ['awaiting_clarification','interrupted']) test('human provenance: force resume cannot bypass a pending approval in '+status,async t=>{
 const g=await fixture(t);g.runtime.loop.runningSessionIds=()=>[];
 g.runtime.state.db.prepare('UPDATE sessions SET status=? WHERE id=?').run(status,g.id);
 const before=g.row();const r=await g.factories.get('harness_resume').execute('bypass',{sessionId:g.id,invokedBy:'U1',force:true});
 assert.equal(r.details.pendingApproval,true);assert.deepEqual(g.row(),before);assert.equal(g.runtime.loopCalls.length,0);
});
