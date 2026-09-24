import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitAdapter } from "../dist/adapters/git-worktree.js";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
const roots=[];test.after(()=>roots.forEach(p=>rmSync(p,{recursive:true,force:true})));
const git=(cwd,...args)=>execFileSync("git",["-c","commit.gpgsign=false","-c","user.name=Test","-c","user.email=test@example.com","-C",cwd,...args],{encoding:"utf8"}).trim();
function repo(){const d=mkdtempSync(join(tmpdir(),"b110-"));roots.push(d);git(d,"init","-q","-b","main");writeFileSync(join(d,"README.md"),"seed\n");git(d,"add","-A");git(d,"commit","-m","seed");return d;}
const adapter=()=>new GitAdapter({worktreesRoot:mkdtempSync(join(tmpdir(),"b110-wt-")),logger:{info(){},warn(){},error(){},debug(){}},runawayUntrackedThreshold:50});

test("beta110: harness cache trees do not enter commits",async()=>{const d=repo();writeFileSync(join(d,"src.ts"),"export const x=1;\n");mkdirSync(join(d,".npm-cache-tmp","_cacache"),{recursive:true});for(let i=0;i<30;i++)writeFileSync(join(d,".npm-cache-tmp","_cacache",`f${i}`),"x");await adapter().commit(d,"work",{name:"Test",email:"test@example.com"});assert.deepEqual(git(d,"show","--name-only","--pretty=format:","HEAD").split("\n").filter(Boolean),["src.ts"]);});

test("beta110: ordinary multi-file project work remains committable",async()=>{const d=repo();mkdirSync(join(d,"generated"));for(let i=0;i<25;i++)writeFileSync(join(d,"generated",`f${i}.json`),"{}\n");await adapter().commit(d,"generate",{name:"Test",email:"test@example.com"});assert.equal(git(d,"show","--name-only","--pretty=format:","HEAD").split("\n").filter(Boolean).length,25);});

test("beta110: readiness rejects a committed path outside confirmed scope",()=>{const h="d".repeat(40),r="e".repeat(64);const result=evaluatePrReadiness({finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,verificationProbes:{completed:1,required:1,indeterminate:0},candidateSha:h,publication:{sha:h,observedAt:1},pullRequest:{repository:"o/r",baseRef:"main",headSha:h,open:true},expectedRepository:"o/r",expectedBaseRef:"main",requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:h,status:"success"},runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass"},elapsedTimeMs:1,timeLimitMs:10,changedPaths:["src/x.ts",".npm-cache-tmp/blob"],allowedScope:["src/**"],excludedScope:[".npm-cache-tmp/**"],operationsPerformed:["commit"],allowedOperations:["commit"],credentialRouteDigest:r,expectedCredentialRouteDigest:r,secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:2},2);assert.equal(result.ready,false);assert.ok(result.failures.includes("scope_exceeded"));});
