// beta.44 restored: keep same-PR adapter behavior; revise interactions are not public control-plane operations.
import test from "node:test";
import assert from "node:assert/strict";
import { createPullRequest } from "../dist/adapters/github.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");

test("beta44: createPullRequest reuses an existing open PR on GitHub's already-exists 422", async()=>{
  const real=globalThis.fetch; let lookup=false;
  globalThis.fetch=async(url,opts)=>{const u=String(url);if(opts?.method==="POST"&&u.endsWith("/pulls"))return new Response(JSON.stringify({message:"A pull request already exists for owner:harness/x."}),{status:422,headers:{"content-type":"application/json"}});if(u.includes("/pulls?head=")){lookup=true;return new Response(JSON.stringify([{number:858,html_url:"https://github.com/o/r/pull/858",node_id:"N1"}]),{status:200,headers:{"content-type":"application/json"}});}throw new Error(`unexpected ${u}`);};
  try { const out=await createPullRequest({repoFullName:"owner/repo",head:"harness/x",base:"main",title:"t",body:"b",ghToken:"tok",draft:false});assert.equal(out.number,858);assert.equal(out.updatedExisting,true);assert.equal(lookup,true); } finally { globalThis.fetch=real; }
});

test("beta44: unrelated 422 responses still fail", async()=>{
  const real=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({message:"Validation failed: base is invalid"}),{status:422,headers:{"content-type":"application/json"}});
  try { await assert.rejects(()=>createPullRequest({repoFullName:"o/r",head:"harness/x",base:"bad",title:"t",body:"b",ghToken:"tok",draft:false}),/PR create failed 422/); } finally { globalThis.fetch=real; }
});

test("beta44: revise/list interactions are absent; autonomous repair stays behind confirmation",()=>{
  const reg=readFileSync(resolve(root,"src/tools/registration.ts"),"utf8");
  assert.doesNotMatch(reg,/name:\s*"harness_(revise|list_revisable)"/);
  assert.match(reg,/function tool\(\s*name: string,\s*description: string,\s*parameters: unknown/);
  assert.match(reg,/harness_confirm_change/);
});
