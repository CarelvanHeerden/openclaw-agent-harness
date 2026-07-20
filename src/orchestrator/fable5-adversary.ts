/**
 * Fable-5 adversarial reviewer.
 *
 * Reviews the diff produced by the workers, plus (optionally) live runtime
 * data from Vercel preview logs, and produces a `ReviewReport`.
 *
 * Dimensions reviewed (documented so the adversary prompt can quote them):
 *   1. Spec fidelity: does the diff satisfy every acceptance criterion?
 *   2. Codebase fit: does it match existing patterns/conventions?
 *   3. Quality: types, tests, lint, no `any`, no dead code, no TODO leaks.
 *   4. Security: no secrets, no obvious injection/XSS, no dangerous deps.
 *   5. Runtime: preview deploy status, log errors, unhandled promise rejections.
 *
 * Runtime sources are pluggable behind `harness.vercel.enabled`:
 *   - vercel: automatic bridge (preview build + event logs)
 *   - manual: uploaded via `harness_upload_logs` tool (any deploy target)
 *   - none:   nothing available; adversary must not sign off on runtime
 *
 * Runtime rule (unchanged): if the runtime data is missing or shows
 * `no_deploy_yet`/`build_failed`/`unavailable`, the adversary gets an
 * explicit banner and MUST refuse to sign off on the runtime dimension.
 */

export interface AdversaryInput {
  crystallisedPrompt: string;
  diffPath: string;
  repoPath: string;
  runtime?: {
    provider: "vercel" | "manual" | "local";
    status: "ok" | "no_deploy_yet" | "build_failed" | "unavailable";
    deploymentUrl?: string;
    logsExcerpt?: string;
    errorCount?: number;
    uploadedAt?: number;         // epoch ms, present when provider=manual
    uploadedBy?: string;         // slack user id, present when provider=manual
    source?: string;             // free-form label the uploader gave, e.g. "prod nginx access log"
    // beta.7 fix #1: present when provider="local" — observable-side-effect
    // verification results synthesised from the harness's own probes.
    localVerification?: Array<{ seq: number; ok: boolean; summary: string }>;
  };
  reviewChecklist: string[];      // from the lead plan
  model: string;
  timeoutSeconds: number;
}

export interface ReviewFinding {
  dimension: "spec" | "fit" | "quality" | "security" | "runtime";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface ReviewReport {
  verdict: "pass" | "revise" | "block";
  findings: ReviewFinding[];
  summary: string;
  sdkSessionId?: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Adversary prompt-preamble helper. Injected verbatim into the adversary's
 * system prompt so runtime dimension is never silently skipped.
 */
export function runtimeBanner(input: AdversaryInput): string {
  if (!input.runtime) {
    return "NO RUNTIME DATA AVAILABLE (runtime bridge disabled).";
  }
  const p =
    input.runtime.provider === "manual"
      ? "MANUAL UPLOAD"
      : input.runtime.provider === "local"
        ? "LOCAL VERIFICATION"
        : "Vercel preview";

  // beta.7 fix #1: local provider carries observable-side-effect checks.
  // These are hard facts (a branch either exists on origin or it does not),
  // so they DO count as runtime data for sub-tasks with observable outputs.
  if (input.runtime.provider === "local") {
    const lines = (input.runtime.localVerification ?? [])
      .map((v) => `  - sub-task ${v.seq}: ${v.ok ? "VERIFIED" : "FAILED"} — ${v.summary}`)
      .join("\n");
    const failed = input.runtime.errorCount ?? 0;
    if (failed > 0) {
      return `RUNTIME DATA (LOCAL VERIFICATION): ${failed} observable side-effect(s) FAILED. A worker reported success but the output does not exist. Treat as CRITICAL — do NOT sign off.\n${lines}`;
    }
    return `RUNTIME DATA (LOCAL VERIFICATION): all observable side-effects verified against git/provider/disk.\n${lines}`;
  }

  switch (input.runtime.status) {
    case "ok":
      if (input.runtime.provider === "manual") {
        return `RUNTIME DATA (${p}${input.runtime.source ? `, ${input.runtime.source}` : ""}${input.runtime.uploadedBy ? `, uploaded by ${input.runtime.uploadedBy}` : ""}) - ${input.runtime.errorCount ?? "unknown"} error(s) in the excerpt.`;
      }
      return `RUNTIME DATA: ${p} ${input.runtime.deploymentUrl ?? "(unknown url)"} - ${input.runtime.errorCount ?? 0} error(s) in logs.`;
    case "no_deploy_yet":
      return "NO RUNTIME DATA AVAILABLE: preview deploy has not completed within the wait window. Do NOT sign off on runtime concerns; flag as MEDIUM.";
    case "build_failed":
      return `RUNTIME DATA: build FAILED for ${p} ${input.runtime.deploymentUrl ?? "(unknown url)"}. Treat as CRITICAL unless the diff intentionally breaks the build.`;
    case "unavailable":
      return `NO RUNTIME DATA AVAILABLE: ${p} bridge returned an error. Do NOT sign off on runtime concerns; flag as MEDIUM.`;
  }
}

export function buildAdversarySystemPrompt(input: AdversaryInput): string {
  return [
    "You are an adversarial code reviewer. Your job is to find EVERY reason this diff should not ship.",
    "Do not be diplomatic. Be exhaustive but honest.",
    "",
    "## Dimensions",
    "1. Spec fidelity: does the diff satisfy each acceptance criterion?",
    "2. Codebase fit: does it match existing patterns/conventions?",
    "3. Quality: types, tests, lint, `any` leaks, TODOs, dead code.",
    "4. Security: secrets in code, injection, XSS, dangerous deps.",
    "5. Runtime: see runtime banner. If banner says NO RUNTIME DATA, you MUST NOT sign off on runtime.",
    "",
    // beta.48 (C3): the ROOT cause of the #858 revise dead-end. In session
    // 21da9f9c the adversary emitted finding 10 with an UNVERIFIED
    // CONDITIONAL -- "IF no existing 'grc' directories exist, this introduces
    // a second naming convention". The premise was false (89 lib + 8
    // component files, 398 refs already used grc/), but the conditional got
    // flattened downstream into an unconditional rename mandate. When the
    // beta.47 lead (correctly) stripped the escape hatch, the worker was
    // forced to confront a false-premise instruction and (correctly) refused
    // -- dead-ending the run. The adversary HAS repo access; it must resolve
    // its own conditionals rather than pass them downstream.
    "## Finding discipline (CRITICAL)",
    "- Do NOT emit a finding whose severity or recommended action depends on an UNRESOLVED CONDITIONAL about repo state ('if X exists...', 'assuming Y is not used elsewhere...', 'unless Z is an established convention...'). You have repo access: RUN THE CHECK (grep/ls/read) and resolve the conditional YOURSELF before finalising the finding.",
    "- After checking: if the condition holds, emit a DEFINITE finding stating what you verified ('grep confirms 0 other files use path P, so introducing P here creates a new convention'). If it does NOT hold, DROP the finding (or downgrade it) -- do not pass a false or unverified premise downstream. A conditional finding becomes an unconditional mandate by the time it reaches the worker, who then either does the wrong thing or refuses.",
    "- Naming/convention findings specifically: before claiming something introduces a NEW convention, grep the repo for the EXISTING prevalence of both the old and proposed names. Report the counts. A rename that leaves N siblings behind is usually worse than the status quo.",
    "",
    "## Runtime banner",
    runtimeBanner(input),
    "",
    "## Review checklist (from the lead planner)",
    ...input.reviewChecklist.map((c) => `- ${c}`),
    "",
    "## Verdict rules",
    "- `pass`: no findings above `medium`, AND every checklist item is verifiably met.",
    "- `revise`: findings the worker can fix in another cycle.",
    "- `block`: findings that require a redesign, a scope change, or human intervention.",
    "",
    "Return a strict JSON object matching the ReviewReport schema. No prose outside the JSON.",
  ].join("\n");
}

export interface AdversaryDeps {
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
  callAdversaryModel: (input: {
    systemPrompt: string;
    diffText: string;
    model: string;
    timeoutSeconds: number;
  }) => Promise<{
    parsed: { verdict: ReviewReport["verdict"]; findings: ReviewFinding[]; summary: string };
    sdkSessionId: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  }>;
  readDiff: (diffPath: string) => Promise<string>;
}

export async function runAdversary(
  input: AdversaryInput,
  deps: AdversaryDeps,
): Promise<ReviewReport> {
  const systemPrompt = buildAdversarySystemPrompt(input);
  const diffText = await deps.readDiff(input.diffPath);
  const result = await deps.callAdversaryModel({
    systemPrompt,
    diffText,
    model: input.model,
    timeoutSeconds: input.timeoutSeconds,
  });

  // Force runtime-dimension safety net: if no runtime data, upgrade any
  // silent "pass" to at least "revise" and inject a MEDIUM finding.
  const wantsRuntimeGuard =
    input.runtime && ["no_deploy_yet", "unavailable"].includes(input.runtime.status);
  let verdict = result.parsed.verdict;
  const findings = [...result.parsed.findings];
  if (wantsRuntimeGuard) {
    const hasRuntimeFinding = findings.some((f) => f.dimension === "runtime");
    if (!hasRuntimeFinding) {
      findings.push({
        dimension: "runtime",
        severity: "medium",
        title: "No runtime data",
        detail:
          "Adversary did not have preview-deploy logs at review time. Runtime dimension is unproven.",
      });
    }
    if (verdict === "pass") verdict = "revise";
  }

  return {
    verdict,
    findings,
    summary: result.parsed.summary,
    sdkSessionId: result.sdkSessionId,
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
}
