import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHarnessTools } from "../dist/tools/registration.js";
function catalog(){const tools=[],commands=[];registerHarnessTools({logger:{info(){},warn(){},error(){}},registerTool(d){tools.push(typeof d==="function"?d({requesterSenderId:"U",conversationId:"C"}):d);return()=>{}},registerCommand(d){commands.push(d);return()=>{}}},{});return{tools,commands};}

test("beta121: the caller sees four operations and no skill/command side channel",()=>{const {tools,commands}=catalog();assert.deepEqual(tools.map(x=>x.name).sort(),["harness_change_result","harness_confirm_change","harness_merge_change","harness_prepare_change"]);assert.deepEqual(commands,[]);});

test("beta121: prepare accepts the complete request directly",()=>{const prepare=catalog().tools.find(x=>x.name==="harness_prepare_change");assert.ok(prepare);const schema=JSON.stringify(prepare.parameters);assert.match(schema,/request/);assert.match(schema,/repository/);assert.doesNotMatch(schema,/requestPath|slackThread|requester|invokedBy/);});

test("beta121: confirmation input cannot supply trusted identity or rewrite scope",()=>{const confirm=catalog().tools.find(x=>x.name==="harness_confirm_change");const schema=JSON.stringify(confirm.parameters);assert.match(schema,/changeId/);assert.doesNotMatch(schema,/requester|invokedBy|actor|conversation|scope|budget|timeLimit|brief/);});

test("beta121: package no longer ships an ordinary-user interaction skill",()=>{const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));const manifest=JSON.parse(readFileSync(new URL("../openclaw.plugin.json",import.meta.url),"utf8"));assert.ok(!pkg.files?.includes("skills"));assert.ok(!manifest.skills||manifest.skills.length===0);});

test("beta121: public descriptions contain no retired operating instructions",()=>{const text=JSON.stringify(catalog().tools.map(({name,description,parameters})=>({name,description,parameters})));assert.doesNotMatch(text,/harness_(answer|run|revise|progress|resume)|clarification|poll every|slash command/i);});
