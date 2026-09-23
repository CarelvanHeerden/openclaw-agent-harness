import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync as Database} from 'node:sqlite';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {registerHarnessTools}=await import(pathToFileURL(resolve(root,'dist/tools/registration.js')));
const {openStateStoreSync}=await import(pathToFileURL(resolve(root,'dist/state/store.js')));

function makeRuntime({dbPath=':memory:',delegated=false}={}) {
 const db=new Database(dbPath);db.exec(readFileSync(resolve(root,'dist/state/schema.sql'),'utf8'));
 const audits=[];const loopCalls=[];
 return {
  state:{db,isOpen:()=>true,audit(event,payload,sessionId){audits.push({event,payload,sessionId});},close(){}},audits,loopCalls,
  loop:{run:async(sessionId,brief)=>{loopCalls.push({sessionId,brief});return{status:'shipped'};},runningSessionIds:()=>[]},
  crystallise:async()=>({kind:'brief',costUsd:0,brief:{title:'Compliance calendar',motivation:'m',acceptanceCriteria:['stable recurrence'],filesLikelyTouched:[],outOfScope:[],riskLevel:'high'}}),
  anthropicApiKey:async()=> 'sk-test',githubServiceFor:()=> 'github-o',githubToken:async()=> 'gh',
  gitResolutionFor:()=>({credentialService:'github-o',provider:'github',apiBase:'https://api.github.com',apiKeyEnv:'GH_TOKEN'}),gitToken:async()=> 'gh',budget:{getDailySpend:()=>0},
  config:{storage:{audit_retention_days:90},slack:{listener_enabled:false,channel:'C1',authorised_users:['U1']},repos:{allowed:['o/*']},
   models:{lead:'l',worker:'w',adversary:'a',classifier:'c',auth:{credential_service:'anthropic-x'}},
   pat_routing:{overrides:{},commit_identity:{},default_service_pattern:'github-{owner}',auth:{api_key_env:'GH_TOKEN'}},
   budgets:{session_default_usd:40},loop:{session_hard_timeout_seconds:18000,clarification_auto_accept_delegated:delegated}},
 };
}

async function fixture(t,opts={}) {
 const runtime=makeRuntime(opts);t.after(()=>runtime.state.db.close());
 const definitions=new Map();const commands=[];
 const api={logger:{info(){},warn(){},error(){}},registerTool(def){definitions.set(def.name,def);return()=>{};},registerCommand(def){commands.push(def);}};
 registerHarnessTools(api,runtime);
 const get=(name,context)=>{const def=definitions.get(name);return typeof def==='function'?def(context??{}):def;};
 const run=await get('harness_run',{requesterSenderId:'U1'}).execute('run',{requester:'U1',request:'build a tenant-safe compliance calendar'});
 const id=run.details.sessionId;const row=()=>runtime.state.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
 const answer=(text,{context={requesterSenderId:'U1'},invokedBy='U1',answeredBy='human',clarificationSeq=-2,clarificationId,evidence}={})=>
  get('harness_answer',context).execute('answer',{sessionId:id,answer:text,invokedBy,answeredBy,clarificationSeq,...(clarificationId?{clarificationId}:{}),...(evidence?{evidence}:{})});
 return {runtime,definitions,commands,get,id,row,answer};
}

test('human provenance: branch-push CI runs the focused provenance mutation gate',()=>{
 const ci=readFileSync(resolve(root,'.github/workflows/ci.yml'),'utf8');
 assert.match(ci,/name: Provenance mutation check \(branch push\)/);
 assert.match(ci,/node scripts\/mutation-check\.mjs 'rc\.13 human provenance:'/);
});

test('human provenance: no direct harness answer command is registered',async t=>{
 const g=await fixture(t);assert.equal(g.commands.some(c=>c.name==='harness-answer'),false);
});

test('human provenance: authenticated OpenClaw requester may answer naturally',async t=>{
 const g=await fixture(t);const result=await g.answer('confirm');
 assert.equal(result.details.ok,true);assert.equal(g.runtime.loopCalls.length,1);assert.equal(g.row().status,'planning');
 const audit=g.runtime.audits.find(a=>a.event==='tool.answer_brief_confirmed');assert.ok(audit);
});

for(const [name,options] of [
 ['missing host requester',{context:{}}],
 ['mismatched host requester',{context:{requesterSenderId:'U2'}}],
 ['mismatched claimed invoker',{invokedBy:'U2'}],
 ['whitespace-only host requester',{context:{requesterSenderId:'   '}}],
]) test(`human provenance: ${name} fails closed`,async t=>{
 const g=await fixture(t);const before={...g.row()};const result=await g.answer('confirm',options);
 assert.equal(result.details.unauthorised,true);assert.deepEqual({...g.row()},before);assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: authenticated sender must remain in slack.authorised_users',async t=>{
 const g=await fixture(t);g.runtime.config.slack.authorised_users=[];const before={...g.row()};
 const result=await g.answer('confirm');assert.equal(result.details.unauthorised,true);assert.deepEqual({...g.row()},before);
});

test('human provenance: model-supplied owner or trusted-human fields cannot mint authority',async t=>{
 const g=await fixture(t);const def=g.get('harness_answer',{requesterSenderId:'U2',senderIsOwner:true,trustedHuman:true});const before={...g.row()};
 const result=await def.execute('spoof',{sessionId:g.id,answer:'confirm',invokedBy:'U1',answeredBy:'human',clarificationSeq:-2});
 assert.equal(result.details.unauthorised,true);assert.deepEqual({...g.row()},before);assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: stale clarification sequence is rejected before mutation',async t=>{
 const g=await fixture(t);const before={...g.row()};const result=await g.answer('confirm',{clarificationSeq:99});
 assert.equal(result.details.staleSeq,true);assert.deepEqual({...g.row()},before);assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: current clarification id is required and exact',async t=>{
 const g=await fixture(t);g.runtime.state.db.prepare('UPDATE sessions SET clarification_id=? WHERE id=?').run('clar-current',g.id);
 for(const clarificationId of [undefined,'clar-stale']) {
  const before={...g.row()};const result=await g.answer('confirm',{clarificationId});
  assert.equal(result.details.staleClarificationId,true);assert.deepEqual({...g.row()},before);
 }
 const accepted=await g.answer('confirm',{clarificationId:'clar-current'});assert.equal(accepted.details.ok,true);
});

test('human provenance: automation needs authenticated provenance as well as delegation and evidence',async t=>{
 const g=await fixture(t,{delegated:true});
 // Brief confirmation is intentionally never delegable, but provenance is checked first.
 const denied=await g.answer('confirm',{answeredBy:'automation',evidence:'verified',context:{}});
 assert.equal(denied.details.unauthorised,true);
 const policy=await g.answer('confirm',{answeredBy:'automation',evidence:'verified'});
 assert.equal(policy.details.briefApprovalNotDelegable,true);assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: force resume cannot bypass a pending approval',async t=>{
 const g=await fixture(t);const before={...g.row()};
 const result=await g.get('harness_resume').execute('resume',{sessionId:g.id,invokedBy:'U1',force:true});
 assert.equal(result.details.pendingApproval,true);assert.deepEqual({...g.row()},before);assert.equal(g.runtime.loopCalls.length,0);
});

test('human provenance: legacy receipt schema remains readable without destructive migration',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');
 const dir=mkdtempSync(resolve(tmpdir(),'legacy-receipt-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=resolve(dir,'state.db');
 const legacy=new Database(path);legacy.exec(`CREATE TABLE human_answer_challenges (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,sender TEXT NOT NULL,state_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER)`);
 legacy.prepare('INSERT INTO human_answer_challenges VALUES (?,?,?,?,?,NULL)').run('legacy','S','U1','hash',9999999999999);legacy.close();
 const store=openStateStoreSync(path);t.after(()=>store.close());const row=store.db.prepare("SELECT id,review_page_count,reviewed_through FROM human_answer_challenges WHERE id='legacy'").get();
 assert.deepEqual({...row},{id:'legacy',review_page_count:1,reviewed_through:1});
});
