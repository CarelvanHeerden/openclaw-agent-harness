import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluatePrReadiness } from "../dist/control/readiness.js";
const roots=[];test.after(()=>roots.forEach(p=>rmSync(p,{recursive:true,force:true})));
const git=(cwd,...args)=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8"}).replace(/\n$/,"");

test("beta112: local git resets ambient credential helpers before installing its own",()=>{const repo=mkdtempSync(join(tmpdir(),"b112-repo-")),bin=mkdtempSync(join(tmpdir(),"b112-bin-"));roots.push(repo,bin);git(repo,"init","-q");const helper=(name,user)=>{const p=join(bin,`${name}.sh`);writeFileSync(p,`#!/bin/sh\n[ \"$1\" = get ] || exit 0\necho username=${user}\necho password=x\n`);chmodSync(p,0o700);return p;};git(repo,"config","--local","credential.helper",helper("ambient","wrong"));git(repo,"config","--replace-all","credential.helper","");git(repo,"config","--add","credential.helper",helper("harness","right"));const filled=execFileSync("git",["-C",repo,"credential","fill"],{input:"protocol=https\nhost=github.com\n\n",encoding:"utf8"});assert.match(filled,/username=right/);assert.doesNotMatch(filled,/username=wrong/);});

const head="c".repeat(40),route="f".repeat(64);const base=(over={})=>({finalVerdict:"pass",blockingFindings:0,reviewCompleted:true,verificationProbes:{completed:1,required:1,indeterminate:0},candidateSha:head,publication:{sha:head,observedAt:20},pullRequest:{repository:"o/r",baseRef:"main",headSha:head,open:true},expectedRepository:"o/r",expectedBaseRef:"main",requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:head,status:"success"},runtimeEvidence:{status:"not_required"},securityEvidence:{status:"pass",sha:head,observedAt:1},elapsedTimeMs:1,timeLimitMs:10,changedPaths:["src/x.ts"],allowedScope:["src/**"],excludedScope:[],operationsPerformed:["test"],operationReceipts:[{operation:"test",observedAt:1,source:"test-fixture"}],allowedOperations:["test"],credentialRouteDigest:route,expectedCredentialRouteDigest:route,secretExposure:{detected:false,evidence:"pass"},spendUsd:1,budgetUsd:2,...over});

test("beta112: a pass carrying a blocking finding is not ready",()=>{const r=evaluatePrReadiness(base({blockingFindings:1}),21);assert.equal(r.ready,false);assert.ok(r.failures.includes("blocking_findings"));});

test("beta112: exact publication, PR head and CI SHA must agree",()=>{for(const over of [{publication:{sha:"0".repeat(40),observedAt:20}},{pullRequest:{repository:"o/r",baseRef:"main",headSha:"0".repeat(40),open:true}},{requiredCi:{registered:true,requiredChecks:["test"],successfulChecks:["test"],sha:"0".repeat(40),status:"success"}}]){const r=evaluatePrReadiness(base(over),21);assert.equal(r.ready,false);assert.ok(r.failures.some(x=>x==="stale_publication"||x==="pr_identity_mismatch"||x==="required_ci_not_green"));}});

test("beta112: missing, pending or partial CI evidence fails closed",()=>{for(const requiredCi of [{registered:false,requiredChecks:[],successfulChecks:[],sha:head,status:"indeterminate"},{registered:true,requiredChecks:["test"],successfulChecks:[],sha:head,status:"pending"}]){const r=evaluatePrReadiness(base({requiredCi}),21);assert.equal(r.ready,false);assert.ok(r.failures.some(x=>x.startsWith("required_ci_")));}});
