# Harness spec: environment-aware build/test verification (local-native vs GitHub Actions)

Author: Clark · 2026-07-27 · grounded against current **beta.76** source

> **🚧 DEFERRED TO v1.1.0 (Carel, 2026-07-27).** This is a LARGE feature and is
> explicitly parked until AFTER we ship **1.0.0**. Do NOT start building this
> before 1.0.0 is out. The current focus is getting the harness **out of beta
> for Vercel/Next.js projects** → 1.0.0. This native/CI verification work is the
> first planned **1.1.0** feature. Future-me: if you are reading this while the
> version is still `0.1.0-beta.*` or `1.0.0`, STOP — finish the Vercel 1.0.0
> line first.

> Origin: Carel, 2026-07-27, #openclaw-staging "Non Project Thanos smoke test"
> thread. Two real project ideas surfaced (a) a GRC tabletop mobile app, (b)
> replacing **Teramind** with an in-house macOS/endpoint monitoring agent built
> on Carel's Apple developer account. Both require building **native
> iOS/macOS/Android** artifacts. The current harness worker runs inside a
> **Linux Docker container** (Staging `openclaw-okf-test`) and CANNOT compile or
> sign Apple targets — the Apple toolchain (Xcode / `xcodebuild` / Simulator /
> code-signing) is macOS-only, full stop; Android *can* run on Linux but needs a
> fat SDK/NDK/emulator the container lacks.
>
> Carel's design constraint (verbatim intent): **keep it flexible.** He has a
> spare **MacBook M3 Pro**. If OpenClaw + the harness run there **bare-metal
> (non-Docker, macOS)**, the harness should DETECT the platform and offer the
> user a choice: **build/verify locally** (native macOS toolchain present) or
> **delegate to GitHub Actions**. On a Linux Docker host like Staging today it
> should **default to GitHub Actions**. One verification abstraction, two
> backends, environment picks the default, user can override.

> **Relationship to the standing "land #858 / clean smoke first" directive:**
> this is a NET-NEW capability, not a #858 fix. Sequence it AFTER a clean
> non-Thanos smoke (the clarification-step test Carel wants) so we do not stack
> an unproven verification backend on top of an unvalidated generalisation run.
> This spec is the unlock for EVERY native/mobile/desktop target the harness
> will ever be asked to build; it deserves its own validated rollout.

---

## 1. Problem statement

### 1.1 What "the harness can't build iOS" actually means

It is **not** a code limitation in the harness. It is a **host-capability**
limitation:

- **Apple targets (iOS / macOS / watchOS / tvOS)**: `xcodebuild`, the SDKs, the
  Simulator, and code-signing exist **only on macOS**. No Linux path exists,
  legally or technically. The Staging container is Linux → hard wall.
- **Android**: Gradle + Android SDK + NDK + (optionally) an emulator run on
  Linux, but the Staging image doesn't ship them, and the emulator wants
  KVM/nested-virt. Solvable by fattening the image, but heavy.
- **Anything else the container lacks** (a specific Rust target, a Python
  version, a system lib) is the same class of problem generalised.

Today the harness's verification model is **synchronous, in-container**:
`repo-conventions.ts` `runCheckScripts()` spawns the repo's declared
`package.json` scripts (`typecheck`/`lint`/`test`/`okf:check`) **inline in the
worktree** during the final-verify sub-task, and the beta.60
`subtask_deadline_seconds` net bounds it. That model can only ever verify **what
the host itself can run.**

### 1.2 The two backends we want

1. **local-native** — the host has the toolchain (e.g. macOS with Xcode for
   Apple targets). Run the build/test **locally, synchronously**, exactly like
   `runCheckScripts` does today, just with a build command instead of an npm
   script. This is the M3 Pro path.
2. **ci (GitHub Actions)** — the host lacks the toolchain. The worker writes the
   code + a workflow (or the repo already has one), the harness **pushes the
   branch**, then **polls the GitHub Actions / Checks API for that SHA** and
   gates on the run's conclusion. `macos-latest` runners give us real Mac VMs
   with Xcode preinstalled; `ubuntu-latest` gives Android/Linux. This is the
   Staging-Docker default.

We already have **most of the CI primitive**: `github.ts`
`getCombinedStatus({repoFullName, sha, ghToken})` (added beta.34) merges the
legacy Statuses API and the Check-Runs API into `"success" | "failure" |
"pending" | "none"`. The missing piece is a **verify-contract kind that polls
it with a wait/timeout**, plus **capability detection** to choose the backend.

---

## 2. Design overview (three layers, each independently shippable)

```
┌── Layer A: capability detection ──────────────────────────────────────┐
│ hostCapabilities(): { platform, native: {apple, android, node, ...},  │
│                       ci: {githubActions}, preferred: "local"|"ci" }  │
│ Detected once at bootstrap, published on the runtime, overridable via  │
│ config verify.build.backend = "auto" | "local" | "ci".                │
└────────────────────────────────────────────────────────────────────────┘
              │  chooses backend for a build/test verification
              ▼
┌── Layer B: the `build_passed` verify kind ────────────────────────────┐
│ New SubTaskVerify kind: { kind: "build_passed"; target; backend?; ... }│
│ verify.ts dispatches to ONE of:                                        │
│   • runLocalBuild()  → spawn build cmd in worktree (sync, like checks) │
│   • pollCiForSha()   → push + getCombinedStatus() loop w/ wait budget  │
└────────────────────────────────────────────────────────────────────────┘
              │  async CI needs a non-blocking wait mode
              ▼
┌── Layer C: async CI wait execution mode ──────────────────────────────┐
│ A CI verification can take 5–15 min (macOS build+sign). Do NOT hold    │
│ the worker turn. Introduce a WAIT phase in loop.ts that polls between  │
│ subtask_deadline ticks, with its own generous ci_wait_timeout.         │
└────────────────────────────────────────────────────────────────────────┘
```

**Flexibility is the point:** Layers A + B ship the abstraction; a given host
just resolves a different backend. The SAME `build_passed` contract on the M3
Pro runs `xcodebuild` locally; on Staging it pushes + polls Actions. The lead
and worker never encode "iOS is impossible here" — they express *intent*
("the macOS target must compile and tests must pass"), and the environment
resolves *how*.

---

## 3. Layer A — host capability detection

### 3.1 New module `src/env/host-capabilities.ts`

Pure + cheap + cached. Detects, does not assume.

```ts
export interface NativeToolchains {
  /** macOS + `xcodebuild -version` succeeds → can build/sign Apple targets. */
  apple: boolean;
  /** `ANDROID_HOME`/`ANDROID_SDK_ROOT` set AND `sdkmanager`/`gradle` present. */
  android: boolean;
  /** node + npm/pnpm/yarn present (already implied today). */
  node: boolean;
  /** generic: xcode-select path, java, python3, rustc, go — extend freely. */
  [tool: string]: boolean;
}

export interface CiCapabilities {
  /** repo has a resolvable GitHub token AND is a GitHub remote. */
  githubActions: boolean;
}

export interface HostCapabilities {
  platform: NodeJS.Platform;           // "darwin" | "linux" | "win32"
  arch: string;                        // "arm64" (M3) | "x64" | ...
  inContainer: boolean;                // /.dockerenv or cgroup heuristic
  native: NativeToolchains;
  ci: CiCapabilities;
  /** default backend when a contract says backend:"auto" (§4.3). */
  preferred: "local" | "ci";
}

export function detectHostCapabilities(deps?: {
  runProbe?: (cmd: string, args: string[]) => { ok: boolean; out: string };
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
}): HostCapabilities;
```

Detection rules (all best-effort, never throw):

- `platform`/`arch`: `process.platform` / `process.arch`.
- `inContainer`: `existsSync('/.dockerenv')` OR `/proc/1/cgroup` contains
  `docker`/`containerd`/`kubepods`. Staging → true; M3 bare-metal → false.
- `native.apple`: `platform === 'darwin'` AND `xcodebuild -version` exits 0 AND
  `xcode-select -p` resolves. (macOS without Xcode ≠ apple-capable.)
- `native.android`: `ANDROID_HOME || ANDROID_SDK_ROOT` set AND a `gradle`/
  `sdkmanager` binary resolves.
- `ci.githubActions`: the repo's PAT resolves (reuse `pat-router` +
  `verifyRepoAccess`) AND remote host is `github.com`.
- `preferred`:
  - `inContainer && !native.apple` → **`"ci"`** (the Staging default Carel
    specified).
  - `!inContainer && (native.apple || native.android)` → **`"local"`** (the M3
    default).
  - otherwise `ci.githubActions ? "ci" : "local"` (fall back to whatever can
    actually run).

> **Why a probe injection:** unit tests pass a fake `runProbe`/`existsSync`/
> `env` and assert the M3 (`darwin`+xcodebuild-ok+not-container → local/apple)
> vs Staging (`linux`+container+no-xcode → ci) matrices deterministically,
> with ZERO real spawns. Same discipline as `worktrees-preflight.ts`.

### 3.2 Publish on the runtime

`index.ts bootstrapHarnessAsync` calls `detectHostCapabilities()` once, logs a
one-line summary (`harness.host_capabilities { platform, preferred, apple,
android, githubActions }`), and stashes it on the runtime so
`runtime-registry.ts` consumers (tools, loop) can read it. **No heavy import
into the registry** — store a plain `HostCapabilities` object.

### 3.3 Config override (`verify.build`)

New optional `VerifyConfig.build` block (additive; manifest
`additionalProperties:false` means EVERY new key must be declared — beta.34
lesson, called out explicitly so we don't repeat the config-reject bug):

```ts
export interface BuildVerifyConfig {
  /** "auto" (use detected preferred), "local", or "ci". Default "auto". */
  backend: "auto" | "local" | "ci";
  /** When true, if the resolved backend is unavailable, FAIL the contract
   *  loudly instead of silently skipping. Default true (fail-closed). */
  require_backend: boolean;
  /** Named build targets → command + backend hints (§4.2). */
  targets?: Record<string, BuildTargetSpec>;
  /** CI polling (§5). */
  ci_wait_timeout_seconds: number;    // default 1800 (30 min; macOS builds are slow)
  ci_poll_interval_seconds: number;   // default 20
  /** Local build wall-clock cap. Default 1800. */
  local_build_timeout_seconds: number;
}
```

Defaults land in `config.ts` DEFAULTS **and** `openclaw.plugin.json`. Absent
block ⇒ backend `"auto"`, fail-closed, no targets, CI timeout 30 min.

---

## 4. Layer B — the `build_passed` verify kind

### 4.1 New `SubTaskVerify` variant (`fable5-lead.ts`)

Additive to the existing union (§ current lines 30–42). Same discipline as
every kind since beta.9.

```ts
| {
    kind: "build_passed";
    /** named target from verify.build.targets, OR an inline command. */
    target?: string;
    /** inline override (used when no named target). e.g. for a custom step. */
    command?: string;
    /** platform this build REQUIRES. If set and no backend can satisfy it,
     *  the contract fails-closed with a clear "needs macOS/Android" reason. */
    requires?: "apple" | "android" | "linux" | "node" | "any";
    /** force a backend for THIS contract, overriding detection + config. */
    backend?: "local" | "ci";
    /** for CI: workflow/check name to gate on (else gate on combined status). */
    checkName?: string;
    /** for CI: branch to poll (defaults to the run's push branch). */
    branch?: string;
  }
```

Scope classification (`verify-contract.ts`):
- `build_passed` with `backend:"ci"` (or auto→ci) is a **remote-scope** kind
  (it needs a push + network). With `backend:"local"` it is **local-scope**.
  Because the backend can be dynamic, treat `build_passed` as **mixed-scope**
  for the beta.14 `contractScope` filter: it is NOT stripped by
  `contractScope:"local"` (a local-native build is legitimately local), and NOT
  stripped by `observe` mode filtering (it verifies state, doesn't itself
  mutate). Add it to NEITHER `REMOTE_SCOPE_KINDS` nor `MUTATION_SCOPE_KINDS`;
  document the reasoning inline.

### 4.2 Build target specs (`verify.build.targets`)

A named, reusable mapping so a lead can say `target:"ios"` without knowing the
command. Example config (this is DATA, operator-authored, not hardcoded):

```jsonc
"verify": {
  "build": {
    "backend": "auto",
    "targets": {
      "ios":   { "requires": "apple",   "local": "xcodebuild -scheme App -destination 'generic/platform=iOS' build",
                 "ci": { "workflow": "ios.yml",   "checkName": "build-ios" } },
      "macos": { "requires": "apple",   "local": "xcodebuild -scheme App -destination 'platform=macOS' build test",
                 "ci": { "workflow": "macos.yml", "checkName": "build-macos" } },
      "android": { "requires": "android", "local": "./gradlew assembleDebug testDebugUnitTest",
                 "ci": { "workflow": "android.yml", "checkName": "build-android" } }
    }
  }
}
```

```ts
export interface BuildTargetSpec {
  requires?: "apple" | "android" | "linux" | "node" | "any";
  /** command to run when backend resolves to local. */
  local?: string;
  /** CI gate: which workflow/check to wait on for this target. */
  ci?: { workflow?: string; checkName?: string };
}
```

### 4.3 Backend resolution (pure, testable — `src/env/resolve-backend.ts`)

```ts
export function resolveBuildBackend(args: {
  contract: Extract<SubTaskVerify, { kind: "build_passed" }>;
  target?: BuildTargetSpec;
  caps: HostCapabilities;
  config: BuildVerifyConfig;
}): { backend: "local" | "ci"; reason: string }
 | { backend: null; failClosed: true; reason: string };
```

Precedence:
1. `contract.backend` explicit → use it (but if `require_backend` and it's
   unavailable, fail-closed with the reason).
2. `config.backend` `"local"`/`"ci"` explicit → use it.
3. `"auto"`: satisfy `contract.requires`/`target.requires`:
   - needs `apple` and `caps.native.apple` → local; else if
     `caps.ci.githubActions` → ci; else fail-closed "no macOS host and no CI".
   - needs `android` similarly.
   - `any`/unset → `caps.preferred`.
4. Never silently pass. A `build_passed` contract that can't be satisfied by
   ANY backend returns `failClosed:true` → the sub-task FAILS with a human-
   readable reason (matches beta.57 fail-closed philosophy: a mis-resolved
   backend must not green-light).

### 4.4 verify.ts dispatch

Add the `build_passed` case to `verifySubTaskOutput`'s switch. Two new **probes**
on `VerifyProbes` (optional for back-compat, fail-closed when absent — beta.57
rule):

```ts
/** Run a local build/test command in the worktree. Resolves pass/fail + log tail. */
runLocalBuild?: (cmd: string, cwd: string, timeoutMs: number)
  => Promise<{ passed: boolean; detail: string }>;

/** Poll CI for a SHA until terminal or timeout. Wraps getCombinedStatus. */
pollCiStatus?: (args: {
  repoFullName: string; sha: string; checkName?: string;
  timeoutMs: number; intervalMs: number;
}) => Promise<{ conclusion: "success" | "failure" | "pending" | "none"; detail: string }>;
```

- **local backend** → `runLocalBuild` (reuse the `defaultRunScript` spawn +
  `HEAP_OOM_RE` retry + exit-126/127 env-classify machinery from
  `repo-conventions.ts`; factor the spawn helper so both share it). Pass ⇔ exit
  0. This is literally the existing check-script path with a build command.
- **ci backend** → `pollCiStatus` (§5). Pass ⇔ `success`. `none` (no checks
  configured on the SHA) is a **fail-closed** with reason "CI expected but no
  workflow ran for <sha> — is the workflow file present + triggered?" (a
  missing workflow must not read as success).

Wire the real probes in **both** `buildVerifyProbes` factories (loop-path and
worker-path in `index.ts` — beta.10 lesson: wire BOTH or 5 kinds skip-pass; now
they fail-closed, which is louder but still wrong if unwired).

---

## 5. Layer C — async CI wait execution mode

### 5.1 The problem

A macOS Actions build + sign is 5–15 min. The worker turn and the beta.60
`subtask_deadline_seconds` (2100 s) are built for synchronous work; holding a
worker turn open for a 15-min CI poll wastes model budget (the worker is idle)
and risks the deadline net killing a legitimately-slow CI wait.

### 5.2 The model — a dedicated CI-wait, decoupled from the worker turn

For a sub-task whose contract includes a `build_passed{backend:"ci"}`:

1. The worker finishes its code turn normally (writes code + workflow, commits).
   Its `subtask_deadline` bounds only the **code** turn, as today.
2. The loop **pushes the branch** for that SHA (CI can't run on an unpushed
   commit — this is the one place a local-scope run must push early; gate it so
   only a `build_passed{ci}` contract triggers the early push, and record
   `loop.ci_push_for_build {branch, sha}`).
3. The loop enters a **CI-wait**: call `pollCiStatus` with
   `ci_wait_timeout_seconds` / `ci_poll_interval_seconds`. This wait is
   **separate** from `subtask_deadline_seconds` (which is a worker-turn net) —
   introduce `loop.ci_wait_deadline_seconds` (default = `ci_wait_timeout` +
   margin) so the outer dispatcher net doesn't pre-empt a legit CI run. Emit
   `loop.ci_wait_started` / `loop.ci_wait_result {conclusion, elapsedMs}`.
4. `success` → sub-task passes. `failure` → sub-task fails with the failing
   check names + a link to the run (feeds the adversary as real runtime
   evidence — closes the beta.69 "no runtime data" gap for native builds!).
   `pending` at timeout → fail-closed "CI did not finish within N min"
   (configurable; a human can bump `ci_wait_timeout`).

> **Implementation note (flexible, not over-built):** v1 can keep the CI-wait
> **inside** the loop's async run (a bounded `await pollCiStatus(...)` with its
> own timeout, NOT the worker turn). That's the smallest correct change and
> reuses beta.34 `getCombinedStatus`. A future v2 can make it a truly
> suspendable wait (persist an `awaiting_ci` state like beta.55's
> `awaiting_clarification`, release the worktree, resume on a webhook / cron
> poll) — but ONLY if 15-min in-run waits prove too costly. Do NOT build the
> suspend machinery until the simple bounded wait is shown insufficient.

### 5.3 GitHub Actions vs Checks API

Gate on **`getCombinedStatus`** (already merges Statuses + Check-Runs). If a
`checkName` is supplied, additionally filter Check-Runs to that name for a
precise gate (extend `getCombinedStatus` with an optional `checkName` filter, or
add a thin `getCheckRunConclusion(repo, sha, checkName)`). Prefer Check-Runs
(that's what `actions/*` reports as) over the legacy Statuses API. `none` ⇒
fail-closed as in §4.4.

---

## 6. Lead + worker prompt changes

### 6.1 Lead (`claude-sdk.ts` lead system prompt)

- Teach the lead the `build_passed` verify kind and that native/desktop targets
  MUST use it (not a local `runCheckScripts`, which can't build them).
- Teach it to **express the requirement, not the mechanism**: emit
  `verify: [{ kind: "build_passed", target: "macos", requires: "apple" }]` and
  let the environment resolve local-vs-CI. It should NOT hardcode `xcodebuild`
  in a worker sub-task on a Linux host.
- When the resolved backend will be CI, the lead should ensure a sub-task
  **authors/updates the workflow file** (`.github/workflows/*.yml` with the
  right `runs-on: macos-latest` / `ubuntu-latest`) as part of the plan, because
  CI can only gate on a workflow that exists.

### 6.2 Worker (`sonnet-worker.ts`)

- New guidance: "If your sub-task's verification is `build_passed` with a CI
  backend, you do NOT run the native build yourself (this host can't). Write the
  code AND ensure the GitHub Actions workflow exists and is correct; the harness
  pushes and waits for the run." — prevents the beta.51/54 async-coordination
  confabulation class ("waiting for the watcher") by making the contract, not
  the worker, own the wait.
- With a **local** backend the worker MAY run the build inline (it's present),
  same as today's check scripts.

---

## 7. Tools / observability

- `harness_progress`: surface CI-wait state — `Building on CI (macos.yml) —
  <elapsed>/<timeout>` and the terminal conclusion, so Carel can watch it from
  Slack the way he watches sub-tasks today.
- New audit events: `harness.host_capabilities`, `loop.build_backend_resolved
  {backend, reason}`, `loop.ci_push_for_build`, `loop.ci_wait_started`,
  `loop.ci_wait_result`, `loop.build_local_result`.
- Optional `harness_env` read-only tool: dumps `detectHostCapabilities()` so
  Carel can ask "what can this host build?" from chat (great for confirming the
  M3 vs Staging matrix after he stands up OpenClaw on the MacBook).

---

## 8. Test plan (no real builds, no real CI in unit tests)

Following the harness's injected-dependency discipline:

1. `host-capabilities.test`: fake `runProbe`/`existsSync`/`env` → assert the
   full matrix: M3 bare-metal (darwin+arm64+xcodebuild-ok+not-container →
   preferred=local, apple=true); Staging (linux+container+no-xcode →
   preferred=ci, apple=false, githubActions=true); macOS-without-Xcode
   (darwin+xcode-missing → apple=false); no-token (githubActions=false).
2. `resolve-backend.test`: every precedence rung, incl. fail-closed cases
   (requires apple + no apple + no CI → failClosed; explicit backend +
   require_backend + unavailable → failClosed).
3. `verify-build.test`: `verifySubTaskOutput` for `build_passed` with a stubbed
   `runLocalBuild` (pass/fail/exit-126-env) and stubbed `pollCiStatus`
   (success/failure/pending-timeout/none-fail-closed); missing-probe →
   fail-closed (beta.57).
4. `ci-wait.test`: behavioral loop test with a fake `pollCiStatus` that returns
   pending N times then success → asserts `loop.ci_wait_started/result` audits,
   the early push fired once, and the sub-task passes; a pending-forever fake →
   fail-closed at timeout.
5. Config + manifest: `verify.build` defaults present; manifest declares every
   new key (a deliberately-undeclared key test to prove `additionalProperties:
   false` would reject — guards the beta.34 regression).
6. Scope-classification: `build_passed` is NOT stripped by `contractScope:
   "local"` NOR by `observe` mode.

Target: keep the green-before-merge bar (typecheck 0 + build 0 + full suite +
smoke, locally AND CI, per every prior beta).

---

## 9. Rollout sequencing

- **beta.N (this)**: Layers A + B + C v1 (bounded in-run CI wait). Land with
  `verify.build.backend` defaulting `"auto"`, no targets configured → **zero
  behavior change** for existing JS/TS smokes (no sub-task emits `build_passed`
  until a lead/brief uses it). This makes it SAFE to ship before the native
  projects exist.
- **Validation step 1 (Staging, Linux/ci)**: a tiny throwaway repo with a
  trivial `ubuntu-latest` workflow. Fire a brief whose plan includes a
  `build_passed{backend:ci}`. Prove: early push → CI-wait → success gate →
  green, all audits fire. This validates the ci backend WITHOUT needing a Mac.
- **Validation step 2 (M3 Pro, macOS/local)**: stand up OpenClaw + harness
  bare-metal on the MacBook. `harness_env` should report `preferred=local,
  apple=true`. Fire a trivial SwiftPM/`xcodebuild` build → local backend runs
  it, gates green. This validates capability detection + local backend.
- **Then**: the real projects (Teramind-replacement macOS agent; the tabletop
  app) become buildable — code on any host, verified via macOS Actions when off
  a Mac, or locally on the M3.

---

## 10. Explicit non-goals / flexibility guarantees

- We do NOT hardcode "iOS/macOS = impossible" anywhere. The harness expresses
  build *intent* (`build_passed{requires:"apple"}`); the host resolves *how*.
- We do NOT require a Mac. The GitHub Actions `macos-latest` backend means a
  pure-Linux Staging can still ship + verify Apple apps.
- We do NOT fatten the Staging Docker image with Android/Xcode. CI carries that.
- We do NOT build the suspend/resume `awaiting_ci` machinery in v1. A bounded
  in-run poll is the smallest correct thing; suspend is a v2 IF cost demands it.
- We do NOT change any existing verify kind, scope filter, or the beta.60/76
  deadline/re-derivation logic. `build_passed` is purely additive.

---

## 11. Open questions for Carel

1. **Apple credentials on CI**: signing/notarizing on `macos-latest` needs the
   Apple dev certs + provisioning profiles as GitHub Actions secrets. For a
   *build+test* gate we can skip signing (unsigned simulator build). Do you want
   the harness verification to gate on **unsigned build+test** (simple, no
   secrets) or full **signed archive** (needs your cert in Actions secrets)?
   Recommendation: gate on unsigned build+test; treat signing/distribution as a
   separate, human-gated release step.
2. **M3 as a self-hosted runner?** Alternative to bare-metal OpenClaw: register
   the M3 as a GitHub self-hosted `macos` runner and let Staging's harness
   delegate Apple builds to it via Actions (Linux host, Mac runner, all one
   backend = ci). This is arguably MORE flexible than local-vs-ci and might
   collapse Layer A. Worth considering — do you want the M3 to run OpenClaw, or
   to be a build runner, or both?
3. **Android emulator tests**: unit tests (`testDebugUnitTest`) run on
   `ubuntu-latest` fine; instrumented/emulator tests need a macOS runner or a
   Linux runner with KVM. Scope emulator tests as out-of-band for v1?
```