/**
 * GitHub REST adapter for the ONE operation the harness performs: open a
 * pull request. Everything else (push, fetch) goes through git.
 *
 * We deliberately do NOT wrap the whole Octokit surface. The plugin should
 * touch as little of GitHub as possible.
 */

export interface CreatePrInput {
  repoFullName: string;
  head: string;           // branch name
  base: string;           // usually "main"
  title: string;
  body: string;
  ghToken: string;
  draft?: boolean;
  /**
   * beta.57 (P3): REST API base. Defaults to public github.com; pass the
   * resolved provider apiBase so GitHub Enterprise hosts work (every other
   * REST call already routes through resolution.apiBase; this adapter was
   * the one hardcoded holdout).
   */
  apiBase?: string;
}

export interface CreatePrOutput {
  number: number;
  htmlUrl: string;
  nodeId: string;
  /** beta.44: true when the PR already existed (revise) and was updated by the push, not newly created. */
  updatedExisting?: boolean;
}

export async function createPullRequest(input: CreatePrInput): Promise<CreatePrOutput> {
  const apiBase = input.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${input.repoFullName}/pulls`;
  const post = async (draft: boolean) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "openclaw-agent-harness/0.1",
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft,
      }),
    });

  let res = await post(!!input.draft);

  // beta.32: draft PRs are rejected with HTTP 422 on repos that don't
  // support them (private repos on free plans, certain repo types). Rather
  // than kill the run at the final step, retry as a non-draft PR. The
  // verdict warning is already embedded in the PR body, so a human still
  // sees the review outcome.
  if (!res.ok && res.status === 422 && input.draft) {
    const peek = await res.clone().text().catch(() => "");
    if (/draft/i.test(peek)) {
      res = await post(false);
    }
  }

  // beta.44: on a revise, a PR already exists for this head branch. GitHub
  // returns 422 with "A pull request already exists for <owner>:<head>". The
  // push (done before this call) has ALREADY updated that PR's head, so this
  // is success, not failure: look up the existing open PR for the head and
  // return it. This is what makes revise UPDATE the same PR instead of
  // erroring or opening a duplicate.
  if (!res.ok && res.status === 422) {
    const peek = await res.clone().text().catch(() => "");
    if (/pull request already exists/i.test(peek)) {
      const [owner] = input.repoFullName.split("/");
      const lookup = `${apiBase}/repos/${input.repoFullName}/pulls?head=${owner}:${encodeURIComponent(input.head)}&state=open`;
      const found = await fetch(lookup, {
        headers: {
          Authorization: `Bearer ${input.ghToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "openclaw-agent-harness/0.1",
        },
      });
      if (found.ok) {
        const arr = (await found.json()) as Array<{ number: number; html_url: string; node_id: string }>;
        if (Array.isArray(arr) && arr.length > 0) {
          const existing = arr[0]!;
          return { number: existing.number, htmlUrl: existing.html_url, nodeId: existing.node_id, updatedExisting: true };
        }
      }
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR create failed ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as { number: number; html_url: string; node_id: string };
  return {
    number: json.number,
    htmlUrl: json.html_url,
    nodeId: json.node_id,
  };
}

/**
 * beta.75 (#1): post a comment on a PR (issue-comments endpoint).
 *
 * WHY: `createPullRequest` writes the review verdict/findings into the PR
 * BODY only at CREATE time. On a re-push to an EXISTING PR (a revise, or a
 * harness_run that D2 promoted onto an open-PR branch), the commits update the
 * PR diff but nothing surfaces the NEW review outcome -- so a `do_not_merge`
 * verdict + its findings were invisible on the PR itself (Carel on #876: "the
 * new test file is there but the PR comments didn't update"). Posting a fresh
 * comment on every review makes each review's verdict/findings visible on the
 * PR timeline, not just in the harness DB. Best-effort: a failed comment must
 * NEVER fail the run (the code + PR already landed), so callers swallow errors.
 */
export async function postPrComment(input: {
  repoFullName: string;
  prNumber: number;
  body: string;
  ghToken: string;
  apiBase?: string;
}): Promise<{ ok: boolean; status: number; htmlUrl?: string; error?: string }> {
  const apiBase = input.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "openclaw-agent-harness/0.1",
      },
      body: JSON.stringify({ body: input.body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 300) };
    }
    const json = (await res.json().catch(() => ({}))) as { html_url?: string };
    return { ok: true, status: res.status, htmlUrl: json.html_url };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/**
 * Sanity-check that a PAT can see a repo. Used at session-start so we
 * fail fast with a clear Slack error instead of dying mid-worker.
 */
export async function verifyRepoAccess(input: { repoFullName: string; ghToken: string }): Promise<{ ok: boolean; status: number; scopes?: string; reason?: string }> {
  const url = `https://api.github.com/repos/${input.repoFullName}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${input.ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-agent-harness/0.1",
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, reason: (await res.text()).slice(0, 200) };
  }
  const scopes = res.headers.get("x-oauth-scopes") ?? undefined;
  return { ok: true, status: res.status, scopes };
}

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "openclaw-agent-harness/0.1",
});

/** beta.34: fetch a PR's head SHA + state (open/closed, merged). */
export async function getPullRequest(input: {
  repoFullName: string;
  prNumber: number;
  ghToken: string;
}): Promise<{ headSha: string; state: string; merged: boolean; mergeable: boolean | null; baseBranch: string }> {
  const res = await fetch(`https://api.github.com/repos/${input.repoFullName}/pulls/${input.prNumber}`, {
    headers: GH_HEADERS(input.ghToken),
  });
  if (!res.ok) throw new Error(`GitHub get PR #${input.prNumber} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    head: { sha: string }; state: string; merged: boolean; mergeable: boolean | null; base: { ref: string };
  };
  return { headSha: j.head.sha, state: j.state, merged: j.merged, mergeable: j.mergeable, baseBranch: j.base.ref };
}

/** Check-run conclusions that mean CI is red. */
const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "stale"];
/** Check-run conclusions that are not red and do not block a green verdict. */
const PASSING_CONCLUSIONS = ["success", "neutral", "skipped"];

export type CiState = "success" | "failure" | "pending" | "none" | "unknown";

/**
 * beta.119: the structured evidence behind a CI verdict. `getCombinedStatus`
 * collapses this to a bare state for the merge-time gate; the polling loop
 * consumes the whole snapshot so it can apply the check-count high-water mark
 * (see `pollCiStatus`) that a single reading cannot.
 */
export interface CiSnapshot {
  state: CiState;
  /** Both API reads succeeded. When false the state is always "unknown". */
  statusReadable: boolean;
  checksReadable: boolean;
  /** Legacy Statuses API. */
  statusState: string;
  statusCount: number;
  /** Check Runs API. */
  checkTotal: number;
  checkIncomplete: number;
  checkFailed: number;
  /** Completed with a conclusion we affirmatively recognise as non-red. */
  checkPassed: number;
  /** Which rule produced `state`, for the audit trail. */
  reason: string;
  /**
   * beta.124: set when a signal was unreadable for a reason that WAITING WILL
   * NOT FIX -- 401/403/404 from GitHub, which mean the token is wrong, lacks a
   * permission, or cannot see the repo. Empty when the failure is transient
   * (5xx, rate limit, network) or when nothing failed.
   *
   * The b123 smoke burned 896 seconds across 44 polls on a check-runs 403 and
   * then reported "could NOT determine CI state", which is true and useless:
   * the answer had arrived, unchanged, on the first poll. The value here is
   * the remedy, phrased for whoever has to go and fix the token.
   */
  permanentDenial: string;
  /**
   * beta.125: which endpoint the check counts came from.
   *
   * `check_runs` is the full picture. `workflow_runs` is the Actions-only
   * fallback taken when the Checks API is denied -- everything GitHub Actions
   * ran is accounted for, and a check run created by a third-party GitHub App
   * is not visible. Callers that report a green must say which one they had.
   */
  checksSource: "check_runs" | "workflow_runs" | "";
}

/** HTTP codes that mean "no", not "not yet". */
const PERMANENT_HTTP = new Set([401, 403, 404]);

/**
 * What an operator should actually go and do about a denial on one of the two
 * CI APIs. GitHub's own message for a missing fine-grained-PAT permission is
 * "Resource not accessible by integration", which names neither the resource
 * nor the permission.
 */
function denialRemedy(api: "statuses" | "check-runs", status: number): string {
  if (status === 401) {
    return `the ${api} API rejected the token (HTTP 401 — bad or expired credentials). CI cannot be read until it is replaced.`;
  }
  if (status === 404) {
    return `the ${api} API returned HTTP 404, which for an authenticated call usually means the token cannot see this repository at all (wrong account, or the repo was not granted to a fine-grained PAT).`;
  }
  // beta.125: b124 said a fine-grained PAT needs the "Checks: read" permission
  // here. No such permission exists. GitHub's REST reference names it on every
  // Checks endpoint, and the token UI has never offered it -- "there is no
  // 'checks' permission in FG PATs at all. Not for read or write." (GitHub, on
  // github/rest-api-description#4290). It is on their own published list of
  // fine-grained limitations: "Using fine-grained personal access token to call
  // the Checks API."
  //
  // So a 403 here is not a misconfiguration an operator can fix by ticking a
  // box, and telling them to go and find one wastes their afternoon. Say what
  // is actually true, and point at the fallback that needs no new grant.
  if (api === "check-runs") {
    return (
      "the token cannot read the check-runs API (HTTP 403). If this is a fine-grained PAT, that is expected and unfixable: " +
      'fine-grained tokens cannot call the Checks API at all — there is no "Checks" permission to grant, and GitHub lists this ' +
      "as a known limitation. The options are a classic PAT with the \"repo\" scope, a GitHub App installation with Checks: read, " +
      'or the Actions workflow-runs fallback (needs only "Actions: read", which fine-grained tokens do support).'
    );
  }
  return (
    'the token cannot read the statuses API (HTTP 403). A fine-grained PAT needs the "Commit statuses: read" repository ' +
    'permission; a classic PAT needs the "repo" scope. Waiting will not change this.'
  );
}

/**
 * beta.125: read a commit's CI state from the Actions workflow-runs API.
 *
 * The b123 smoke could not read check runs and therefore could not read CI --
 * on a repo whose CI is GitHub Actions, with a token that already held
 * `Actions: read`. The information was one endpoint away the entire time.
 *
 * Workflow runs carry the same `status` / `conclusion` vocabulary as check
 * runs, so the caller's existing rules apply unchanged. What this CANNOT see
 * is a check run created by a third-party GitHub App: those are not workflow
 * runs and do not appear here. That blind spot is why the snapshot records
 * where its answer came from.
 */
async function readWorkflowRuns(input: {
  repoFullName: string;
  sha: string;
  ghToken: string;
  base: string;
}): Promise<{ ok: boolean; total: number; incomplete: number; failed: number; passed: number; reason: string }> {
  const miss = { ok: false, total: 0, incomplete: 0, failed: 0, passed: 0, reason: "" };
  try {
    const res = await fetch(
      `${input.base}/repos/${input.repoFullName}/actions/runs?head_sha=${input.sha}&per_page=100`,
      { headers: GH_HEADERS(input.ghToken) },
    );
    if (!res.ok) return { ...miss, reason: `workflow-runs API HTTP ${res.status}` };
    const body = (await res.json()) as {
      total_count?: number;
      workflow_runs?: Array<{ status: string; conclusion: string | null }>;
    };
    const runs = body.workflow_runs ?? [];
    // Same refusal as the check-runs path: a truncated list looks complete.
    if ((body.total_count ?? runs.length) > runs.length) {
      return { ...miss, reason: `workflow-runs truncated (${body.total_count} total, ${runs.length} read)` };
    }
    return {
      ok: true,
      total: runs.length,
      incomplete: runs.filter((r) => r.status !== "completed").length,
      failed: runs.filter((r) => FAILED_CONCLUSIONS.includes(r.conclusion ?? "")).length,
      passed: runs.filter((r) => r.status === "completed" && PASSING_CONCLUSIONS.includes(r.conclusion ?? "")).length,
      reason: "",
    };
  } catch (err) {
    return { ...miss, reason: `workflow-runs API threw: ${String(err).slice(0, 120)}` };
  }
}

/**
 * beta.34: combined CI status for a commit SHA, merging the legacy Statuses API
 * and the Check Runs API into one verdict.
 *
 * beta.119: this gate used to FAIL OPEN, and the b118 smoke shipped on it.
 * ProjectThanos PR #986 was declared green at 21:10:45 while Lint had failed at
 * 21:10:17 and Tests failed at 21:13:39. The old code read both APIs but guarded
 * the check-runs branch with a bare `if (cRes.ok)` and no else, so an
 * unreadable -- or transiently empty, which the Check Runs API genuinely does
 * return under eventual consistency -- check-run list was indistinguishable
 * from "this repo has no check runs". The "nothing configured" guard then
 * required BOTH sources to be empty, and ProjectThanos has exactly one legacy
 * status (Vercel). So the moment Vercel's deploy went green the function fell
 * through `anySuccess` and reported the whole commit green, blind to all ten
 * Actions checks. The old body also ENDED in `return "success"`, making success
 * the default for every state not explicitly matched.
 *
 * The rules below invert that: success requires positive evidence from every
 * signal, and anything we could not read is "unknown", never a pass.
 */
export async function getCiSnapshot(input: {
  repoFullName: string;
  sha: string;
  ghToken: string;
  apiBase?: string;
  /** beta.125: `ci.workflow_runs_fallback`. false restores b124 behaviour. */
  workflowRunsFallback?: boolean;
}): Promise<CiSnapshot> {
  const base = input.apiBase ?? "https://api.github.com";
  const snap: CiSnapshot = {
    state: "unknown", statusReadable: false, checksReadable: false,
    statusState: "", statusCount: 0, checkTotal: 0, checkIncomplete: 0, checkFailed: 0, checkPassed: 0, reason: "",
    permanentDenial: "",
    checksSource: "",
  };
  const denials: string[] = [];

  try {
    const sRes = await fetch(`${base}/repos/${input.repoFullName}/commits/${input.sha}/status`, {
      headers: GH_HEADERS(input.ghToken),
    });
    if (sRes.ok) {
      const sj = (await sRes.json()) as { state?: string; total_count?: number };
      snap.statusReadable = true;
      snap.statusState = sj.state ?? "";
      snap.statusCount = sj.total_count ?? 0;
    } else {
      snap.reason = `statuses API HTTP ${sRes.status}`;
      if (PERMANENT_HTTP.has(sRes.status)) denials.push(denialRemedy("statuses", sRes.status));
    }
  } catch (err) {
    snap.reason = `statuses API threw: ${String(err).slice(0, 120)}`;
  }

  try {
    const cRes = await fetch(`${base}/repos/${input.repoFullName}/commits/${input.sha}/check-runs?per_page=100`, {
      headers: GH_HEADERS(input.ghToken),
    });
    if (cRes.ok) {
      const cj = (await cRes.json()) as {
        total_count?: number;
        check_runs?: Array<{ status: string; conclusion: string | null }>;
      };
      const runs = cj.check_runs ?? [];
      snap.checksReadable = true;
      snap.checksSource = "check_runs";
      snap.checkTotal = runs.length;
      snap.checkIncomplete = runs.filter((r) => r.status !== "completed").length;
      snap.checkFailed = runs.filter((r) => FAILED_CONCLUSIONS.includes(r.conclusion ?? "")).length;
      snap.checkPassed = runs.filter((r) => r.status === "completed" && PASSING_CONCLUSIONS.includes(r.conclusion ?? "")).length;
      // The list is capped at 100 per page. A commit with more checks than that
      // would silently look complete, so refuse to judge it rather than guess.
      if ((cj.total_count ?? runs.length) > runs.length) {
        snap.checksReadable = false;
        snap.reason = `check-runs truncated (${cj.total_count} total, ${runs.length} read)`;
      }
    } else {
      snap.reason = snap.reason ? `${snap.reason}; check-runs API HTTP ${cRes.status}` : `check-runs API HTTP ${cRes.status}`;
      if (PERMANENT_HTTP.has(cRes.status)) denials.push(denialRemedy("check-runs", cRes.status));
    }
  } catch (err) {
    const m = `check-runs API threw: ${String(err).slice(0, 120)}`;
    snap.reason = snap.reason ? `${snap.reason}; ${m}` : m;
  }

  // beta.125: the Checks API is closed to this token, but the commit's CI may
  // not be. Ask the Actions workflow-runs endpoint, which a fine-grained PAT
  // CAN reach with `Actions: read`. Only on a permanent denial -- a transient
  // 5xx should be re-polled against the real endpoint, not routed around.
  if (!snap.checksReadable && denials.length > 0 && input.workflowRunsFallback !== false) {
    const wf = await readWorkflowRuns({ repoFullName: input.repoFullName, sha: input.sha, ghToken: input.ghToken, base });
    if (wf.ok) {
      snap.checksReadable = true;
      snap.checksSource = "workflow_runs";
      snap.checkTotal = wf.total;
      snap.checkIncomplete = wf.incomplete;
      snap.checkFailed = wf.failed;
      snap.checkPassed = wf.passed;
      snap.reason = `${snap.reason}; read ${wf.total} Actions workflow run(s) instead`;
    } else if (wf.reason) {
      snap.reason = `${snap.reason}; ${wf.reason}`;
    }
  }

  // A signal we could not read is never evidence of health. This is the b115
  // principle ("a gate that could not run must not read as a pass") applied to
  // the CI gate itself.
  if (!snap.statusReadable || !snap.checksReadable) {
    snap.state = "unknown";
    // b124: still unknown, still never a pass -- but now the caller can tell
    // "come back in twenty seconds" from "go and fix the token".
    snap.permanentDenial = denials.join(" ");
    return snap;
  }

  // Red beats everything, and beats it EARLY: a failed check is already
  // decisive, so there is nothing to gain by waiting out its siblings.
  if (snap.statusState === "failure" || snap.statusState === "error") {
    snap.state = "failure";
    snap.reason = `legacy status state=${snap.statusState}`;
    return snap;
  }
  if (snap.checkFailed > 0) {
    snap.state = "failure";
    snap.reason = `${snap.checkFailed} check run(s) failed`;
    return snap;
  }

  if (snap.checkIncomplete > 0) {
    snap.state = "pending";
    snap.reason = `${snap.checkIncomplete} of ${snap.checkTotal} check run(s) still running`;
    return snap;
  }
  if (snap.statusState === "pending" && snap.statusCount > 0) {
    snap.state = "pending";
    snap.reason = "legacy status still pending";
    return snap;
  }

  // Genuinely nothing configured. GitHub reports the combined state as
  // "pending" with total_count 0 when there are no statuses at all.
  if (snap.statusCount === 0 && snap.checkTotal === 0) {
    snap.state = "none";
    snap.reason = "no statuses and no check runs on this sha";
    return snap;
  }

  // Success demands positive evidence from BOTH signals: every check run
  // concluded well, and the legacy state is green or absent. Note this is
  // vacuously true when `checkTotal` is 0, which is exactly the transient the
  // caller's high-water mark exists to catch -- a repo whose checks have not
  // appeared yet looks identical to one that has none.
  // Every check must be one we recognise as passing -- an unrecognised
  // conclusion is not evidence of health either.
  const allChecksGood = snap.checkPassed === snap.checkTotal;
  const legacyGood = snap.statusCount === 0 || snap.statusState === "success";
  if (legacyGood && allChecksGood) {
    snap.state = "success";
    // beta.125: name the source on a GREEN. A pass read from workflow runs is
    // a pass over everything GitHub Actions ran and the legacy statuses, and
    // is blind to check runs posted by a third-party GitHub App. Saying "12
    // check runs passed" when we never read a check run is the kind of small
    // untruth the b118 false-green was made of.
    snap.reason = snap.checksSource === "workflow_runs"
      ? `${snap.checkTotal} Actions workflow run(s) passed; legacy state=${snap.statusState || "absent"} ` +
        `(read via the workflow-runs fallback: the Checks API was denied, so any third-party check run is unverified)`
      : `${snap.checkTotal} check run(s) passed; legacy state=${snap.statusState || "absent"}`;
    return snap;
  }

  // Anything left is a combination we do not have a rule for. Refuse to call
  // it, rather than defaulting to green the way the pre-b119 code did.
  snap.state = "unknown";
  snap.reason = `unclassified: legacy=${snap.statusState}/${snap.statusCount}, checks=${snap.checkTotal} (${snap.checkFailed} failed, ${snap.checkIncomplete} running)`;
  return snap;
}

/**
 * beta.119: the OAuth scopes GitHub reports for this token.
 *
 * GitHub returns `x-oauth-scopes` on any authenticated request, but ONLY for
 * classic PATs and OAuth tokens. Fine-grained PATs and GitHub App installation
 * tokens return it absent or empty while being perfectly capable, so `null`
 * here means "cannot tell" and must never be read as "cannot do". Never throws.
 */
export async function getTokenScopes(input: { ghToken: string; apiBase?: string }): Promise<string[] | null> {
  const base = input.apiBase ?? "https://api.github.com";
  try {
    const res = await fetch(`${base}/user`, { headers: GH_HEADERS(input.ghToken) });
    const header = res.headers?.get?.("x-oauth-scopes");
    if (header === null || header === undefined) return null;
    const scopes = header.split(",").map((s) => s.trim()).filter(Boolean);
    return scopes.length > 0 ? scopes : null;
  } catch {
    return null;
  }
}

/** beta.34 / beta.119: the bare state. Prefer `getCiSnapshot` where the evidence matters. */
export async function getCombinedStatus(input: {
  repoFullName: string;
  sha: string;
  ghToken: string;
  apiBase?: string;
}): Promise<CiState> {
  return (await getCiSnapshot(input)).state;
}

/**
 * beta.81 (Track B / B2): fetch a short excerpt of the FAILING check-runs for a
 * commit SHA -- each failed run's name, conclusion, and output title/summary --
 * so the harness can surface WHY CI is red as the revise finding source. Never
 * throws; returns "" on any error or when nothing failed.
 */
export async function getFailingCheckLogs(input: {
  repoFullName: string;
  sha: string;
  ghToken: string;
  apiBase?: string;
  /** beta.127: set false to test the check-runs path in isolation. */
  jobLogsFallback?: boolean;
}): Promise<string> {
  const viaChecks = await readFailingCheckRuns(input);
  // beta.127: only a check-runs answer that CARRIES A DIAGNOSIS is allowed to
  // stand. Two separate things were producing "(no log excerpt available)" on a
  // red PR, and the second is the one that survives having the right token:
  //
  //   1. A fine-grained PAT cannot read check-runs at all (the `Checks`
  //      permission does not exist for them -- the b125 finding), so this
  //      returned "".
  //   2. Even when the API answers, GitHub Actions check runs routinely carry
  //      no `output.title` or `output.summary`. On the b126 smoke this produced
  //      the string "- Tests [failure]" -- non-empty, so it short-circuited any
  //      fallback, and worth nothing to the human told not to merge.
  //
  // Verified against Stitch-Vercel/ProjectThanos@1dd2fcb1 with a token that
  // CAN read check-runs: the entire excerpt was 17 characters.
  if (viaChecks.hasDetail) return viaChecks.text;
  if (input.jobLogsFallback === false) return viaChecks.text;
  // The Actions jobs API answers the same question, carries the actual test
  // output, and needs only `Actions: read` -- which is why the b125
  // workflow-runs fallback works on the same token.
  const viaJobs = await readFailingJobLogs(input);
  return viaJobs || viaChecks.text;
}

/** The pre-b127 path: failed check runs and their output summaries. */
async function readFailingCheckRuns(input: {
  repoFullName: string; sha: string; ghToken: string; apiBase?: string;
}): Promise<{ text: string; hasDetail: boolean }> {
  const base = input.apiBase ?? "https://api.github.com";
  try {
    const cRes = await fetch(`${base}/repos/${input.repoFullName}/commits/${input.sha}/check-runs`, {
      headers: GH_HEADERS(input.ghToken),
    });
    if (!cRes.ok) return { text: "", hasDetail: false };
    const cj = (await cRes.json()) as {
      check_runs: Array<{ name: string; conclusion: string | null; output?: { title?: string; summary?: string } }>;
    };
    const failed = (cj.check_runs ?? []).filter((r) =>
      ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""),
    );
    if (failed.length === 0) return { text: "", hasDetail: false };
    const hasDetail = failed.some((r) => Boolean(r.output?.title || r.output?.summary));
    const text = failed
      .map((r) => {
        const title = r.output?.title ? `: ${r.output.title}` : "";
        const summary = r.output?.summary ? `\n  ${r.output.summary.slice(0, 500)}` : "";
        return `- ${r.name} [${r.conclusion}]${title}${summary}`;
      })
      .join("\n")
      .slice(0, 2000);
    return { text, hasDetail };
  } catch {
    return { text: "", hasDetail: false };
  }
}

/** How much of one job's log we are willing to pull into memory. */
const JOB_LOG_MAX_BYTES = 4_000_000;

/**
 * beta.127: read the failing job logs through the Actions API.
 *
 * Three hops, all on `Actions: read`: runs for the sha, jobs in those runs,
 * then the log text for each failed job. The log is a plain-text blob behind a
 * redirect, prefixed with an RFC3339 timestamp per line and full of ANSI
 * colour -- both are stripped, because the point of this text is that a model
 * reads it and finds the file that broke.
 *
 * beta.131: the run filter used to require a run-level conclusion of failure,
 * and that made this entire function dead code on every live run.
 *
 * A workflow run's `conclusion` stays null until EVERY job in it finishes. The
 * harness is woken by check-runs, which conclude per job. So the sequence is
 * always: the Tests job goes red, the check-run says failure, the harness asks
 * "which runs concluded as failed?" -- and the answer is "none", because Build
 * and Security Scan are still going. Measured on 03a8a7b6: the job concluded
 * at 10:29:05Z, the harness ruled at 10:29:28Z, the run did not conclude until
 * 10:30:34Z. Sixty-six seconds too early, every single time.
 *
 * The caller then fell through to the check-runs text, which for GitHub Actions
 * is routinely just "- Tests [failure]" -- no test, no file, nothing to route
 * a repair at. b127 shipped the CI-repair cycle on top of this and it never
 * once produced a routable finding: four releases of a feature that could only
 * ever spend a cycle guessing.
 *
 * So the run-level conclusion is no longer consulted as a gate. Runs that
 * concluded green hold nothing worth reading; everything else -- failed,
 * cancelled, and crucially still-running -- is a candidate, and the job-level
 * filter below (which was always right) decides what actually gets read.
 */
async function readFailingJobLogs(input: {
  repoFullName: string; sha: string; ghToken: string; apiBase?: string;
}): Promise<string> {
  const base = input.apiBase ?? "https://api.github.com";
  try {
    const rRes = await fetch(
      `${base}/repos/${input.repoFullName}/actions/runs?head_sha=${encodeURIComponent(input.sha)}&per_page=100`,
      { headers: GH_HEADERS(input.ghToken) },
    );
    if (!rRes.ok) return "";
    const rj = (await rRes.json()) as {
      workflow_runs?: Array<{ id: number; name?: string; conclusion: string | null }>;
    };
    const settledGreen = ["success", "skipped", "neutral"];
    const candidateRuns = (rj.workflow_runs ?? []).filter((r) => !settledGreen.includes(r.conclusion ?? ""));
    // A run already known to have failed is likelier to hold the failing job
    // than one still in flight, and only the first two are read.
    const definite = (c: string | null) =>
      ["failure", "timed_out", "cancelled", "action_required"].includes(c ?? "") ? 0 : 1;
    candidateRuns.sort((a, b) => definite(a.conclusion) - definite(b.conclusion));
    if (candidateRuns.length === 0) return "";

    const chunks: string[] = [];
    // Two runs, two jobs each. A repo with ten red jobs has one cause and nine
    // consequences, and a 2000-char excerpt spread over ten of them says
    // nothing about any of them.
    for (const run of candidateRuns.slice(0, 2)) {
      const jRes = await fetch(`${base}/repos/${input.repoFullName}/actions/runs/${run.id}/jobs?per_page=100`, {
        headers: GH_HEADERS(input.ghToken),
      });
      if (!jRes.ok) continue;
      const jj = (await jRes.json()) as {
        jobs?: Array<{ id: number; name: string; conclusion: string | null }>;
      };
      const failedJobs = (jj.jobs ?? []).filter((j) =>
        ["failure", "timed_out", "cancelled", "action_required"].includes(j.conclusion ?? ""),
      );
      for (const job of failedJobs.slice(0, 2)) {
        const text = await readJobLogText(base, input.repoFullName, job.id, input.ghToken);
        const excerpt = extractFailureExcerpt(text);
        chunks.push(
          excerpt
            ? `- ${run.name ? `${run.name} / ` : ""}${job.name} [${job.conclusion}]\n${excerpt}`
            : `- ${run.name ? `${run.name} / ` : ""}${job.name} [${job.conclusion}] (log unreadable)`,
        );
      }
    }
    return chunks.join("\n\n").slice(0, 4000);
  } catch {
    return "";
  }
}

async function readJobLogText(base: string, repo: string, jobId: number, token: string): Promise<string> {
  try {
    const res = await fetch(`${base}/repos/${repo}/actions/jobs/${jobId}/logs`, { headers: GH_HEADERS(token) });
    if (!res.ok || !res.body) return "";
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > JOB_LOG_MAX_BYTES) {
      // Only the end matters and we cannot range-request a signed blob, so
      // stream and keep a trailing window rather than buffering the whole file.
      const dec = new TextDecoder();
      let tail = "";
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        tail = (tail + dec.decode(part, { stream: true })).slice(-200_000);
      }
      return tail;
    }
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Pull the part of a job log that says what broke.
 *
 * Prefers a test runner's own failure summary, falls back to the lines the
 * runner marked as errors, and finally to the tail. Always returns text a
 * human or a model can act on, never the whole log.
 */
export function extractFailureExcerpt(raw: string): string {
  if (!raw) return "";
  const clean = raw
    .split("\n")
    // GitHub prefixes every line with an RFC3339 timestamp.
    .map((l) => l.replace(/^\S*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""))
    // ANSI colour, which also hides file paths from a path matcher.
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\^\[\[[0-9;]*[A-Za-z]/g, ""))
    .filter((l) => l.trim() !== "");

  const summaryAt = clean.findIndex((l) => /Summary of all failing tests|Failed tests:|=== FAILURES ===/i.test(l));
  if (summaryAt >= 0) return clean.slice(summaryAt, summaryAt + 80).join("\n").slice(0, 3000);

  const marked = clean.filter((l) => /##\[error\]|^\s*FAIL\s|^\s*✕|^\s*●|\bAssertionError\b|\bError:/.test(l));
  if (marked.length > 0) return marked.slice(0, 60).join("\n").slice(0, 3000);

  return clean.slice(-40).join("\n").slice(0, 3000);
}

/** beta.34: merge a PR (squash by default). Returns the merge commit SHA. */
export async function mergePullRequest(input: {
  repoFullName: string;
  prNumber: number;
  ghToken: string;
  method?: "squash" | "merge" | "rebase";
  commitTitle?: string;
}): Promise<{ merged: boolean; sha: string; message: string }> {
  const res = await fetch(`https://api.github.com/repos/${input.repoFullName}/pulls/${input.prNumber}/merge`, {
    method: "PUT",
    headers: { ...GH_HEADERS(input.ghToken), "Content-Type": "application/json" },
    body: JSON.stringify({
      merge_method: input.method ?? "squash",
      ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { merged?: boolean; sha?: string; message?: string };
  if (!res.ok) {
    throw new Error(`GitHub merge PR #${input.prNumber} failed ${res.status}: ${j.message ?? ""}`.slice(0, 400));
  }
  return { merged: !!j.merged, sha: j.sha ?? "", message: j.message ?? "" };
}
