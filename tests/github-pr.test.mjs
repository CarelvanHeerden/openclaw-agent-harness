import test from "node:test";
import assert from "node:assert/strict";

let buildPrBody, pushBranchAndOpenPr;
try {
  ({ buildPrBody, pushBranchAndOpenPr } = await import("../dist/adapters/github-pr.js"));
} catch {
  buildPrBody = null;
}

const baseInput = {
  worktreePath: "/tmp/wt",
  repoFullName: "CarelvanHeerden/openclaw-agent-harness",
  baseBranch: "main",
  headBranch: "harness/foo",
  ghToken: "ghp_test",
  requesterHandle: "@carel",
  logger: { info() {}, warn() {} },
  brief: {
    title: "Add /hello endpoint",
    motivation: "we need a smoke endpoint",
    acceptanceCriteria: ["GET /hello -> 200 'hi'"],
    filesLikelyTouched: ["src/routes/hello.ts"],
    outOfScope: [],
    riskLevel: "low",
  },
  reviewReport: {
    verdict: "pass",
    findings: [],
    summary: "Clean.",
    sdkSessionId: "sdk-42",
    costUsd: 0.12,
    tokensIn: 100,
    tokensOut: 50,
  },
  git: null,
};

test("buildPrBody: pass verdict has no draft banner",
  { skip: buildPrBody === null }, () => {
    const body = buildPrBody(baseInput);
    assert.doesNotMatch(body, /draft/i);
    assert.match(body, /we need a smoke endpoint/);
    assert.match(body, /GET \/hello/);
    assert.match(body, /@carel/);
  });

test("buildPrBody: non-pass adds draft banner + findings block",
  { skip: buildPrBody === null }, () => {
    const body = buildPrBody({
      ...baseInput,
      reviewReport: {
        ...baseInput.reviewReport,
        verdict: "revise",
        findings: [
          { dimension: "quality", severity: "medium", title: "Missing test", detail: "No test for /hello" },
        ],
        summary: "Needs tests.",
      },
    });
    assert.match(body, /draft/i);
    assert.match(body, /Missing test/);
    assert.match(body, /medium\/quality/);
  });

test("pushBranchAndOpenPr: uses Bearer auth and returns html_url",
  { skip: buildPrBody === null }, async () => {
    const gitCalls = [];
    const fakeGit = { pushBranch: async (...args) => { gitCalls.push(args); } };
    const fakeFetch = async (url, init) => {
      assert.equal(url, "https://api.github.com/repos/CarelvanHeerden/openclaw-agent-harness/pulls");
      assert.equal(init.method, "POST");
      assert.match(init.headers.Authorization, /^Bearer ghp_test/);
      const body = JSON.parse(init.body);
      assert.equal(body.head, "harness/foo");
      assert.equal(body.base, "main");
      assert.equal(body.draft, false);
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => ({ html_url: "https://github.com/x/y/pull/9", number: 9 }),
      };
    };
    const url = await pushBranchAndOpenPr({ ...baseInput, git: fakeGit, fetchImpl: fakeFetch });
    assert.equal(url, "https://github.com/x/y/pull/9");
    assert.equal(gitCalls.length, 1);
  });

test("pushBranchAndOpenPr: propagates GitHub API failure",
  { skip: buildPrBody === null }, async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: "Validation Failed" }),
      json: async () => ({}),
    });
    await assert.rejects(
      pushBranchAndOpenPr({ ...baseInput, git: { pushBranch: async () => {} }, fetchImpl: fakeFetch }),
      /422/,
    );
  });
