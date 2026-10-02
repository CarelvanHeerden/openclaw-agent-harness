import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getCiSnapshot, getRequiredChecksPolicy } from "../dist/adapters/github.js";
import { exactSuccessfulRequiredChecks, plannerCiDiagnostics, resolveTrustedCiEvidence } from "../dist/orchestrator/ci-authority.js";

const observed=["Secret Scan","CI","Code Quality: PR #1289"];

test("model-invented TruffleHog cannot widen trusted remote CI policy",()=>{
  const proposed=plannerCiDiagnostics([{seq:1,requiredBehaviorChecks:[
    {id:"ci-suite",ciCheck:"CI",command:"npm test",required:true},
    {id:"secret-scan",ciCheck:"TruffleHog",required:true},
  ]}]);
  assert.deepEqual(proposed.map((item)=>item.ciCheck),["CI","TruffleHog"]);
  const trusted=resolveTrustedCiEvidence({
    policyStatus:"readable",
    policyChecks:["Secret Scan","CI"],
    observedChecks:observed,
    providerState:"success",
    plannerChecks:proposed.map((item)=>item.ciCheck),
  });
  assert.equal(trusted.status,"success");
  assert.deepEqual(trusted.requiredChecks,["Secret Scan","CI"]);
  assert.ok(!trusted.requiredChecks.includes("TruffleHog"));
});

test("repository-required checks win when omitted, renamed, or duplicated by the planner",()=>{
  const exact=resolveTrustedCiEvidence({policyStatus:"readable",policyChecks:["Secret Scan","CI"],observedChecks:observed,providerState:"success"});
  assert.equal(exact.status,"success");
  const missing=resolveTrustedCiEvidence({policyStatus:"readable",policyChecks:["Secret Scan","CI","Required Deploy"],observedChecks:observed,providerState:"success"});
  assert.equal(missing.status,"indeterminate");
  assert.deepEqual(missing.successfulChecks,["Secret Scan","CI"]);
});

test("required GitHub App identity must match the observed check producer",()=>{
  const wrong=resolveTrustedCiEvidence({
    policyStatus:"readable",policyChecks:["Security Verdict"],policyBindings:[{context:"Security Verdict",appId:42}],
    observedChecks:["Security Verdict"],observedBindings:[{context:"Security Verdict",appId:99}],providerState:"success",
  });
  assert.equal(wrong.status,"indeterminate");
  const exact=resolveTrustedCiEvidence({
    policyStatus:"readable",policyChecks:["Security Verdict"],policyBindings:[{context:"Security Verdict",appId:42}],
    observedChecks:["Security Verdict"],observedBindings:[{context:"Security Verdict",appId:42}],providerState:"success",
  });
  assert.equal(exact.status,"success");
});

test("explicit confirmed checks are additive and missing names fail before acceptance",()=>{
  const present=resolveTrustedCiEvidence({policyStatus:"readable",policyChecks:["CI"],observedChecks:["CI","Extra Audit"],explicitChecks:["Extra Audit"],providerState:"success"});
  assert.equal(present.status,"success");
  const absent=resolveTrustedCiEvidence({policyStatus:"readable",policyChecks:["CI"],observedChecks:["CI"],explicitChecks:["Extra Audit"],providerState:"success"});
  assert.equal(absent.status,"indeterminate");
});

test("observed exact-SHA repository checks are canonical when policy declares no required contexts",()=>{
  const trusted=resolveTrustedCiEvidence({policyStatus:"readable",policyChecks:[],observedChecks:observed,providerState:"success"});
  assert.equal(trusted.status,"success");
  assert.deepEqual(trusted.requiredChecks,observed);
});

test("unreadable repository policy is indeterminate rather than replaced by planner guesses",()=>{
  for(const policyStatus of ["denied","indeterminate"]){
    const trusted=resolveTrustedCiEvidence({policyStatus,policyChecks:[],observedChecks:observed,providerState:"success"});
    assert.equal(trusted.registered,false);
    assert.equal(trusted.status,"indeterminate");
  }
});

test("GitHub branch rules provide exact required status contexts",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify([
      {type:"required_status_checks",parameters:{required_status_checks:[{context:"Secret Scan"},{context:"CI"},{context:"CI"}]}},
      {type:"pull_request",parameters:{}},
    ]),{status:200,headers:{"content-type":"application/json"}});
    const policy=await getRequiredChecksPolicy({repoFullName:"o/r",baseBranch:"main",ghToken:"t"});
    assert.equal(policy.status,"readable");
    assert.deepEqual(policy.requiredChecks,["Secret Scan","CI"]);
    globalThis.fetch=async()=>new Response("forbidden",{status:403});
    assert.equal((await getRequiredChecksPolicy({repoFullName:"o/r",baseBranch:"main",ghToken:"t"})).status,"denied");
    globalThis.fetch=async()=>new Response("hidden",{status:404});
    assert.equal((await getRequiredChecksPolicy({repoFullName:"o/r",baseBranch:"main",ghToken:"t"})).status,"indeterminate");
  }finally{globalThis.fetch=original}
});

test("classic branch protection is unioned with ruleset status contexts",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url)=>{
      if(String(url).includes("/rules/branches/"))return new Response(JSON.stringify([{type:"required_status_checks",parameters:{required_status_checks:[{context:"Ruleset CI",integration_id:8}]}}]),{status:200,headers:{"content-type":"application/json"}});
      if(String(url).includes("/protection/required_status_checks"))return new Response(JSON.stringify({checks:[{context:"Classic CI",app_id:7}]}),{status:200,headers:{"content-type":"application/json"}});
      throw new Error(String(url));
    };
    const policy=await getRequiredChecksPolicy({repoFullName:"o/r",baseBranch:"main",ghToken:"t"});
    assert.deepEqual(policy.requiredChecks,["Ruleset CI","Classic CI"]);
    assert.deepEqual(policy.requiredCheckBindings,[{context:"Ruleset CI",appId:8},{context:"Classic CI",appId:7}]);
  }finally{globalThis.fetch=original}
});

test("only an explicit unprotected-branch 404 is treated as no classic requirements",async()=>{
  const original=globalThis.fetch;
  try{
    let classicBody=JSON.stringify({message:"Branch not protected"});
    globalThis.fetch=async(url)=>{
      if(String(url).includes("/rules/branches/"))return new Response("[]",{status:200,headers:{"content-type":"application/json"}});
      if(String(url).includes("/protection/required_status_checks"))return new Response(classicBody,{status:404});
      throw new Error(String(url));
    };
    assert.equal((await getRequiredChecksPolicy({repoFullName:"o/r",baseBranch:"main",ghToken:"t"})).status,"readable");
    classicBody=JSON.stringify({message:"Not Found"});
    assert.equal((await getRequiredChecksPolicy({repoFullName:"o/r",baseBranch:"main",ghToken:"t"})).status,"indeterminate");
  }finally{globalThis.fetch=original}
});

test("legacy status contexts and workflow/check names share canonical observed evidence",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url)=>{
      const value=String(url);
      if(value.includes("/status"))return new Response(JSON.stringify({state:"success",total_count:1,statuses:[{context:"Secret Scan"}]}),{status:200,headers:{"content-type":"application/json"}});
      if(value.includes("/check-runs"))return new Response(JSON.stringify({total_count:1,check_runs:[{name:"CI",status:"completed",conclusion:"success"}]}),{status:200,headers:{"content-type":"application/json"}});
      throw new Error(value);
    };
    const snapshot=await getCiSnapshot({repoFullName:"o/r",sha:"a".repeat(40),ghToken:"t"});
    assert.equal(snapshot.state,"success");
    assert.deepEqual(snapshot.statusNames,["Secret Scan"]);
    assert.deepEqual(snapshot.checkNames,["CI"]);
  }finally{globalThis.fetch=original}
});

test("neutral or skipped checks are not exact successful conclusions",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url)=>{
      const value=String(url);
      if(value.includes("/status"))return new Response(JSON.stringify({state:"success",total_count:0,statuses:[]}),{status:200,headers:{"content-type":"application/json"}});
      if(value.includes("/check-runs"))return new Response(JSON.stringify({total_count:2,check_runs:[
        {name:"TypeScript Check",status:"completed",conclusion:"neutral"},
        {name:"CI",status:"completed",conclusion:"success"},
      ]}),{status:200,headers:{"content-type":"application/json"}});
      throw new Error(value);
    };
    const snapshot=await getCiSnapshot({repoFullName:"o/r",sha:"a".repeat(40),ghToken:"t"});
    assert.equal(snapshot.state,"success");
    assert.deepEqual(snapshot.successfulCheckNames,["CI"]);
    assert.deepEqual(exactSuccessfulRequiredChecks(["TypeScript Check","CI"],snapshot.successfulCheckNames),["CI"]);
  }finally{globalThis.fetch=original}
});

test("same-name success from the wrong App cannot satisfy an exact required producer",()=>{
  assert.deepEqual(exactSuccessfulRequiredChecks(
    ["TypeScript Check"],["TypeScript Check"],
    [{context:"TypeScript Check",appId:42}],
    [{context:"TypeScript Check",appId:99}],
  ),[]);
  assert.deepEqual(exactSuccessfulRequiredChecks(
    ["TypeScript Check"],["TypeScript Check"],
    [{context:"TypeScript Check",appId:42}],
    [{context:"TypeScript Check",appId:42}],
  ),["TypeScript Check"]);
});

test("workflow-runs fallback resolves repository job names and app identity",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url)=>{
      const value=String(url);
      if(value.includes("/status"))return new Response(JSON.stringify({state:"success",total_count:0,statuses:[]}),{status:200,headers:{"content-type":"application/json"}});
      if(value.includes("/check-runs"))return new Response("denied",{status:403});
      if(value.includes("/actions/runs?"))return new Response(JSON.stringify({total_count:1,workflow_runs:[{id:9,name:"CI",status:"completed",conclusion:"success"}]}),{status:200,headers:{"content-type":"application/json"}});
      if(value.includes("/actions/runs/9/jobs"))return new Response(JSON.stringify({total_count:2,jobs:[{name:"Lint"},{name:"Tests"}]}),{status:200,headers:{"content-type":"application/json"}});
      throw new Error(value);
    };
    const snapshot=await getCiSnapshot({repoFullName:"o/r",sha:"a".repeat(40),ghToken:"t"});
    assert.equal(snapshot.state,"success");
    assert.deepEqual(snapshot.checkNames,["CI","Lint","Tests"]);
    assert.deepEqual(snapshot.checkBindings,[{context:"CI",appId:15368},{context:"Lint",appId:15368},{context:"Tests",appId:15368}]);
  }finally{globalThis.fetch=original}
});

test("GraphQL rollup recovers third-party required checks when REST Checks is denied",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url)=>{
      const value=String(url);
      if(value.includes("/status"))return new Response(JSON.stringify({state:"success",total_count:1,statuses:[{context:"CodeRabbit"}]}),{status:200,headers:{"content-type":"application/json"}});
      if(value.includes("/check-runs"))return new Response("denied",{status:403});
      if(value.endsWith("/graphql"))return new Response(JSON.stringify({data:{repository:{object:{statusCheckRollup:{contexts:{totalCount:6,nodes:[
        {__typename:"CheckRun",name:"Lint",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{app:{databaseId:15368}}},
        {__typename:"CheckRun",name:"Tests",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{app:{databaseId:15368}}},
        {__typename:"CheckRun",name:"Build",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{app:{databaseId:15368}}},
        {__typename:"CheckRun",name:"TypeScript Check",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{app:{databaseId:15368}}},
        {__typename:"CheckRun",name:"QA Verdict",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{app:{databaseId:5136769}}},
        {__typename:"CheckRun",name:"Security Verdict",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{app:{databaseId:5136817}}},
      ]}}}}}}),{status:200,headers:{"content-type":"application/json"}});
      throw new Error(value);
    };
    const snapshot=await getCiSnapshot({repoFullName:"Stitch-Vercel/StitchGuard",sha:"1e460e51330e3a5490b197e0350f6191f2f2b707",ghToken:"t"});
    assert.equal(snapshot.state,"success");
    assert.equal(snapshot.checksSource,"graphql_rollup");
    assert.ok(snapshot.checkBindings.some((binding)=>binding.context==="QA Verdict"&&binding.appId===5136769));
    assert.ok(snapshot.checkBindings.some((binding)=>binding.context==="Security Verdict"&&binding.appId===5136817));
  }finally{globalThis.fetch=original}
});

test("StitchGuard exact fallback evidence satisfies ruleset contexts without planner aliases",()=>{
  const required=["Lint","Tests","Build","TypeScript Check","CodeRabbit","QA Verdict","Security Verdict"];
  const trusted=resolveTrustedCiEvidence({
    policyStatus:"readable",
    policyChecks:required,
    policyBindings:required.map((context)=>({context,...(context==="QA Verdict"?{appId:5136769}:context==="Security Verdict"?{appId:5136817}:context==="CodeRabbit"?{}:{appId:15368})})),
    observedChecks:["CI","Secret Scan","Code Quality: PR #1289",...required],
    observedBindings:required.map((context)=>({context,...(context==="QA Verdict"?{appId:5136769}:context==="Security Verdict"?{appId:5136817}:context==="CodeRabbit"?{}:{appId:15368})})),
    providerState:"success",
    plannerChecks:["TruffleHog"],
  });
  assert.equal(trusted.status,"success");
  assert.deepEqual(trusted.requiredChecks,required);
  assert.ok(!trusted.requiredChecks.includes("TruffleHog"));
});

test("production has no planner-name behavior gate and emits an authority diagnostic",()=>{
  const root=resolve(import.meta.dirname,"..");
  const loop=readFileSync(resolve(root,"dist/orchestrator/legacy-loop.js"),"utf8");
  assert.match(loop,/planner_ci_requirement_not_authoritative/);
  assert.doesNotMatch(loop,/required CI behavior checks missing/);
  assert.doesNotMatch(loop,/behavior_verification_failed/);
});
