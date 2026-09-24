import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const merge=readFileSync(new URL("../src/control/merge.ts",import.meta.url),"utf8");
test("retired PR-link recovery is not a public tool",()=>{const registration=readFileSync(new URL("../src/tools/registration.ts",import.meta.url),"utf8");assert.doesNotMatch(registration,/harness_link_pr/);});
test("strict merge re-inspects repository, base, PR number, head and readiness",()=>{for(const token of ["provider.inspect","inspection.repository!==auth.repository","inspection.baseRef!==auth.baseRef","inspection.prNumber!==auth.prNumber","inspection.headSha!==auth.expectedHeadSha","evaluatePrReadiness","readiness_changed"])assert.match(merge,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));});
test("provider merge is idempotent and post-verified",()=>{assert.match(merge,/merge_provider_idempotency/);assert.match(merge,/verifyMerged/);assert.match(merge,/already_merged/);});
