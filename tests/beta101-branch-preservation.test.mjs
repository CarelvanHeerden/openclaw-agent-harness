import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GitAdapter } from "../dist/adapters/git-worktree.js";

const roots=[]; test.after(()=>roots.forEach(p=>rmSync(p,{recursive:true,force:true})));
const git=(cwd,...args)=>execFileSync("git",["-c","commit.gpgsign=false","-c","user.name=Test","-c","user.email=test@example.com","-C",cwd,...args],{encoding:"utf8"}).trim();
const logger={info(){},warn(){},error(){},debug(){}};
function world(){const root=mkdtempSync(join(tmpdir(),"b101-"));roots.push(root);const origin=join(root,"origin.git"),seed=join(root,"seed"),worktreesRoot=join(root,"wt");git(root,"init","--bare","-b","main",origin);mkdirSync(seed);git(seed,"init","-b","main");writeFileSync(join(seed,"README.md"),"seed\n");git(seed,"add","-A");git(seed,"commit","-m","seed");git(seed,"remote","add","origin",origin);git(seed,"push","-u","origin","main");const bare=join(worktreesRoot,".repos","o","r.git");mkdirSync(dirname(bare),{recursive:true});git(root,"clone","--bare",origin,bare);return{origin,seed,bare,adapter:new GitAdapter({worktreesRoot,logger,bootstrapDeps:false})};}
async function alloc(w,id,extra={}){git(w.bare,"remote","set-url","origin",w.origin);return w.adapter.allocate({repoFullName:"o/r",baseBranch:"main",sessionBranch:"harness/change",sessionId:id,ghToken:"",commitIdentity:{name:"Test",email:"test@example.com"},...extra});}
async function commit(w,wt,name){writeFileSync(join(wt,name),name);return w.adapter.commit(wt,`add ${name}`,{name:"Test",email:"test@example.com"});}
function advance(w){writeFileSync(join(w.seed,"upstream.txt"),"next\n");git(w.seed,"add","-A");git(w.seed,"commit","-m","upstream");git(w.seed,"push","origin","main");}

test("beta101: reallocation preserves the existing branch tip",async()=>{const w=world();const first=await alloc(w,"one");const sha=await commit(w,first,"feature.ts");advance(w);const second=await alloc(w,"two",{preserveLocalBranch:true});assert.equal(git(second,"rev-parse","HEAD"),sha);assert.ok(existsSync(join(second,"feature.ts")));});

test("beta101: preservation keeps an entire commit chain",async()=>{const w=world();const first=await alloc(w,"one");const shas=[];for(let i=0;i<4;i++)shas.push(await commit(w,first,`step-${i}.ts`));advance(w);const second=await alloc(w,"two",{preserveLocalBranch:true});for(const sha of shas)git(second,"merge-base","--is-ancestor",sha,"HEAD");assert.equal(git(second,"rev-parse","HEAD"),shas.at(-1));});

test("beta101: a destructive reset first creates a durable rescue ref",async()=>{const w=world();const first=await alloc(w,"one");const sha=await commit(w,first,"valuable.ts");advance(w);await alloc(w,"two");const refs=git(w.bare,"for-each-ref","--format=%(refname)","refs/harness-rescue/").split("\n").filter(Boolean);assert.equal(refs.length,1);assert.equal(git(w.bare,"rev-parse",refs[0]),sha);});

test("beta101: a missing branch may be recovered from the recorded checkpoint",async()=>{const w=world();const first=await alloc(w,"one");const sha=await commit(w,first,"checkpoint.ts");await w.adapter.releaseByPath(first,"o/r");git(w.bare,"branch","-D","harness/change");const recovered=await alloc(w,"two",{preserveLocalBranch:true,recoverBranchFromSha:sha});assert.equal(git(recovered,"rev-parse","HEAD"),sha);assert.ok(existsSync(join(recovered,"checkpoint.ts")));});
