/**
 * Repo-convention awareness (beta.63).
 *
 * Origin: Carel's PR #859 review of the b60 taxonomy-dropdown deliverable. The
 * change was good and passed CI, but violated the repo's `keep-okf-current`
 * rule (`npm run okf:check` reported 3 drift issues) — and CI does NOT run
 * `okf:check`, so nothing caught it. Root lesson: THE HARNESS ONLY RESPECTS
 * WHAT THE GATES ENFORCE.
 *
 * Two halves, both here:
 *   Fix 1 — Convention-as-CONTEXT: {@link ingestRepoConventions} reads the
 *     repo's declared convention files at brief build and returns a
 *     char-budgeted `repoConventions[]` that gets threaded into the lead +
 *     worker + adversary SDK prompts (which get NO OpenClaw context injection).
 *   Fix 2 — Convention-as-CHECK: {@link discoverCheckScripts} +
 *     {@link runCheckScripts} run the repo's declared check scripts inline +
 *     blocking in the final-verify sub-task; a non-zero exit becomes a
 *     REVISE-worthy finding (NOT a hard run-fail).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
/** Convention files scanned at the repo root (Fix 1). */
const CONVENTION_FILES = [
    ".cursorrules",
    "CONTRIBUTING.md",
    "CONVENTIONS.md",
    "AGENTS.md",
    ".github/CONTRIBUTING.md",
];
/** Regex a package.json script NAME must match to be discovered (Fix 1/2). */
export const CHECK_SCRIPT_NAME_RE = /check|lint|verify|okf/i;
/** Recursively list files under a dir matching a predicate, bounded in count. */
function listFilesRecursive(dir, pred, max = 200) {
    const out = [];
    const stack = [dir];
    while (stack.length > 0 && out.length < max) {
        const cur = stack.pop();
        let entries;
        try {
            entries = readdirSync(cur);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            const full = join(cur, name);
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                stack.push(full);
            }
            else if (pred(name)) {
                out.push(full);
            }
        }
    }
    return out;
}
/**
 * Fix 1: ingest the repo's declared convention files into a char-budgeted list
 * of `{ source, text }`. Over budget, the LONGEST sources are truncated first
 * (with a note) rather than dropping sources silently. Returns `[]` when the
 * repo declares nothing / the root does not exist. Never throws.
 */
export function ingestRepoConventions(repoRoot, charBudget = 10000) {
    if (!repoRoot || !existsSync(repoRoot))
        return [];
    const collected = [];
    const seen = new Set();
    const add = (source, text) => {
        const t = (text ?? "").trim();
        if (!t)
            return;
        if (seen.has(source))
            return;
        seen.add(source);
        collected.push({ source, text: t });
    };
    // .cursor/rules/**/*.{mdc,md}
    const cursorRulesDir = join(repoRoot, ".cursor", "rules");
    if (existsSync(cursorRulesDir)) {
        for (const f of listFilesRecursive(cursorRulesDir, (n) => n.endsWith(".mdc") || n.endsWith(".md"))) {
            try {
                add(relative(repoRoot, f), readFileSync(f, "utf8"));
            }
            catch { /* skip unreadable */ }
        }
    }
    // Single-file / doc conventions.
    for (const rel of CONVENTION_FILES) {
        const full = join(repoRoot, rel);
        if (existsSync(full)) {
            try {
                add(rel, readFileSync(full, "utf8"));
            }
            catch { /* skip unreadable */ }
        }
    }
    // Repo-declared check scripts (discovered here for Fix 1 visibility; run by Fix 2).
    const scripts = discoverCheckScripts(repoRoot);
    if (scripts.length > 0) {
        add("package.json#scripts", `The repo declares these check scripts (run them to self-verify conventions):\n` +
            scripts.map((s) => `- ${s.name}: ${s.command}`).join("\n"));
    }
    return applyCharBudget(collected, charBudget);
}
/**
 * Enforce the total char budget across all sources. Truncates the LONGEST
 * sources first (each gets an appended note) until the total fits. Never drops
 * a source entirely (it keeps at least a stub) so provenance survives.
 */
export function applyCharBudget(conventions, charBudget) {
    if (!(charBudget > 0))
        return conventions;
    const total = () => conventions.reduce((acc, c) => acc + c.text.length, 0);
    if (total() <= charBudget)
        return conventions;
    const NOTE = "\n\n[... truncated to fit the convention char budget ...]";
    // Longest-first truncation. Repeatedly find the longest source and shave it.
    let guard = 0;
    while (total() > charBudget && guard < 10000) {
        guard++;
        // Pick the longest by text length.
        let idx = 0;
        for (let i = 1; i < conventions.length; i++) {
            if (conventions[i].text.length > conventions[idx].text.length)
                idx = i;
        }
        const c = conventions[idx];
        const over = total() - charBudget;
        // Shave the overflow off this (longest) source, but keep a minimum stub.
        const minStub = 200;
        const target = Math.max(minStub, c.text.length - over - NOTE.length);
        if (target >= c.text.length)
            break; // can't shrink further meaningfully
        c.text = c.text.slice(0, target) + NOTE;
        c.truncated = true;
        // If every source is already at the stub floor, stop to avoid a busy loop.
        if (conventions.every((x) => x.text.length <= minStub + NOTE.length))
            break;
    }
    return conventions;
}
/**
 * Fix 1/2: discover repo-declared check scripts from `package.json#scripts`
 * whose NAME matches {@link CHECK_SCRIPT_NAME_RE}. Returns `[]` when there is
 * no package.json / no matching scripts. Never throws.
 */
export function discoverCheckScripts(repoRoot) {
    const pkgPath = join(repoRoot, "package.json");
    if (!existsSync(pkgPath))
        return [];
    let scripts = {};
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        scripts = pkg.scripts ?? {};
    }
    catch {
        return [];
    }
    const out = [];
    for (const [name, command] of Object.entries(scripts)) {
        if (typeof command === "string" && CHECK_SCRIPT_NAME_RE.test(name)) {
            out.push({ name, command });
        }
    }
    return out;
}
/** Bound the captured output tail so a noisy script can't blow up the audit/log. */
const OUTPUT_TAIL_CHARS = 4000;
/**
 * Fix 2: run the repo-declared check scripts, INLINE + BLOCKING, in the
 * worktree. Only scripts whose name is on `allowlist` are run (a discovered
 * script NOT on the list is NEVER run). Each is bounded by `timeoutSeconds`.
 *
 * Classification of a result:
 *   - exitCode === 0            -> ran, pass (no finding).
 *   - exitCode !== 0 (real)     -> ran, FAIL -> caller emits a REVISE-worthy
 *                                   `loop.convention_check_failed` finding.
 *   - timeout / spawn error /   -> `unrunnable: true` (non-fatal note, NOT a
 *     missing-tool signature         finding) per the beta.53 bootstrap lesson.
 *
 * Never throws. `runScript` is injectable for tests (defaults to spawnSync npm).
 */
export function runCheckScripts(params) {
    const allow = new Set(params.allowlist);
    const results = [];
    const run = params.runScript ?? defaultRunScript;
    const timeoutMs = Math.max(10, params.timeoutSeconds) * 1000;
    for (const s of params.discovered) {
        if (!allow.has(s.name)) {
            // Never run a non-allowlisted script; do not even record it as ran.
            results.push({ script: s.name, ran: false, exitCode: null, outputTail: "", skippedReason: "not on verify.check_script_allowlist" });
            continue;
        }
        let out;
        try {
            out = run(s.name, params.repoRoot, timeoutMs);
        }
        catch (err) {
            results.push({ script: s.name, ran: false, exitCode: null, outputTail: "", unrunnable: true, skippedReason: `spawn error: ${String(err)}` });
            continue;
        }
        const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
        const outputTail = combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined;
        if (out.timedOut) {
            results.push({ script: s.name, ran: false, exitCode: null, outputTail, unrunnable: true, skippedReason: `timed out after ${params.timeoutSeconds}s` });
            continue;
        }
        if (out.error) {
            // A spawn/tool-missing/network error is UNRUNNABLE (non-fatal), not a finding.
            results.push({ script: s.name, ran: false, exitCode: out.status ?? null, outputTail, unrunnable: true, skippedReason: `unrunnable: ${String(out.error)}` });
            continue;
        }
        // beta.69 (F4): exit 127 / "command not found" means the check-script binary
        // (eslint, tsx, ...) is ABSENT from node_modules -- an ENVIRONMENT gap, not a
        // convention failure. In forensic 1f2e6642 the worktree had a partial
        // node_modules so lint/okf:check exited 127 and were scored as blocking
        // convention failures, poisoning cycle-1's review tone. Classify these as
        // `unrunnable` (non-fatal note) so they never become a revise-worthy finding.
        // The worktree bootstrap (git-worktree.ts) owns repairing the env.
        if (out.status === 127 || /\b(command not found|: not found|MODULE_NOT_FOUND|cannot find module)\b/i.test(combined)) {
            results.push({ script: s.name, ran: false, exitCode: out.status ?? 127, outputTail, unrunnable: true, skippedReason: `env_unavailable: check-script binary missing (exit 127 / command not found)` });
            continue;
        }
        results.push({ script: s.name, ran: true, exitCode: out.status ?? null, outputTail });
    }
    return results;
}
/** Default script runner: `npm run <name>` in cwd, bounded by timeout. */
function defaultRunScript(name, cwd, timeoutMs) {
    const res = spawnSync("npm", ["run", "--silent", name], {
        cwd,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
    });
    const timedOut = res.signal === "SIGTERM" && !!res.error;
    return {
        status: res.status,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        error: res.error && !timedOut ? res.error : undefined,
        timedOut: !!(res.error && res.error.code === "ETIMEDOUT") || timedOut,
    };
}
/**
 * Render the repoConventions block for an SDK system prompt. Shared by the
 * lead / worker / adversary prompt builders so all three carry the same text
 * (they get NO OpenClaw context injection). Returns "" when there are none.
 */
export function renderConventionsForPrompt(conventions, role) {
    if (!conventions || conventions.length === 0)
        return "";
    const guidance = role === "lead"
        ? "Respect these repo conventions when planning file placement and sub-tasks. If a convention conflicts with the brief, surface it as a finding — do NOT silently violate it."
        : role === "worker"
            ? "Respect these repo conventions for any file you touch (placement, regeneration steps, formatting). Do NOT silently violate them."
            : "Flag any change that violates a stated repo convention, even if CI is green (e.g. an OKF bundle not regenerated, a file placed in the wrong directory).";
    const body = conventions
        .map((c) => `--- ${c.source}${c.truncated ? " (truncated)" : ""} ---\n${c.text}`)
        .join("\n\n");
    return `\n\nREPO CONVENTIONS (declared by the target repo):\n${guidance}\n\n${body}\n`;
}
//# sourceMappingURL=repo-conventions.js.map