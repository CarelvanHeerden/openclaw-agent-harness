#!/usr/bin/env node
/**
 * rc.6: tell an operator what `verify.generators` will do to their runs BEFORE
 * they install a build that enforces it.
 *
 * WHY THIS EXISTS. rc.6 refuses a `produces` path that `repos.never_commit_paths`
 * also covers, because that pair cannot be satisfied by any worker: the
 * generator is told to write the file, the exclusion list unstages AND restores
 * it before the commit, the contract then fails because the artifact was never
 * committed, and the failure advice ("run the generator") loses to the same
 * revert next cycle. rc.5 and earlier let that combination through and the run
 * simply never converged.
 *
 * Enforcement is per-run, not at config load: each rejected path becomes a
 * blocking `high` finding on every cycle, and the path itself ends up UNOWNED,
 * which means no generation and no exemption from its ordinary contract check.
 * So a deployment carrying this contradiction keeps loading and keeps failing,
 * which is a good reason to look at it on the ground before upgrading.
 *
 * READ-ONLY BY CONSTRUCTION. This script opens the config and, optionally, the
 * repository tree. It writes nothing, to either. The narrowing it prints is a
 * proposal to review, not a change to apply -- deciding what belongs in version
 * control is not a decision a preflight gets to make.
 *
 * Usage:
 *   node scripts/generator-config-preflight.mjs <config.json> [--repo <path>]
 *
 * <config.json> may be a whole `~/.openclaw/openclaw.json` or just the plugin's
 * own config block; both shapes are recognised. Pass `--repo` to have the
 * proposal computed against the real tree rather than guessed.
 *
 * Exit status is 1 when a contradiction is found, so this can gate a rollout.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PLUGIN_ID = "openclaw-agent-harness";

let resolveGenerators, neverCommitCovers, normaliseRepoPath;
try {
  ({ resolveGenerators, neverCommitCovers, normaliseRepoPath } = await import(
    "../dist/orchestrator/generated-artifacts.js"
  ));
} catch {
  console.error("Could not load dist/. Run `npm run build` first.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
let configPath = null;
let repoPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--repo") {
    repoPath = argv[++i] ?? null;
    continue;
  }
  if (argv[i] === "-h" || argv[i] === "--help") {
    console.log("usage: node scripts/generator-config-preflight.mjs <config.json> [--repo <path>]");
    process.exit(0);
  }
  if (configPath === null) configPath = argv[i];
}
if (!configPath) {
  console.error("usage: node scripts/generator-config-preflight.mjs <config.json> [--repo <path>]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Accept either the whole OpenClaw config or the plugin block on its own. An
 * operator reaching for this script is mid-incident; making them extract the
 * right sub-object first is an avoidable way to get a wrong answer from a
 * correct tool.
 */
function readConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Could not read ${path}: ${err.message}`);
    process.exit(2);
  }
  const nested = parsed?.plugins?.entries?.[PLUGIN_ID]?.config;
  if (nested && typeof nested === "object") return { config: nested, shape: "openclaw.json" };
  return { config: parsed ?? {}, shape: "plugin config block" };
}

const { config, shape } = readConfig(configPath);
const generators = Array.isArray(config?.verify?.generators) ? config.verify.generators : [];
const neverCommit = Array.isArray(config?.repos?.never_commit_paths) ? config.repos.never_commit_paths : [];

console.log(`Config:          ${configPath} (read as a ${shape})`);
console.log(`Generators:      ${generators.length} mapping(s)`);
console.log(`never_commit:    ${neverCommit.length ? neverCommit.join(", ") : "(empty)"}`);
console.log("");

if (generators.length === 0) {
  console.log("No verify.generators declared, so rc.6 has nothing to refuse here.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// What rc.6 will do
// ---------------------------------------------------------------------------

// The harness's own resolver, not a re-implementation of it: a preflight that
// disagrees with the thing it is previewing is worse than no preflight.
const strict = resolveGenerators(generators, { neverCommitPaths: neverCommit });
const withoutExclusions = resolveGenerators(generators);

const conflicts = [];
const otherErrors = [];
for (const e of strict.errors) {
  const alsoWithout = withoutExclusions.errors.some(
    (o) => o.script === e.script && o.path === e.path && o.reason === e.reason,
  );
  // An error that survives with the exclusion list removed is a different
  // problem wearing the same coat, and narrowing will not touch it.
  if (alsoWithout) otherErrors.push(e);
  else conflicts.push(e);
}

if (conflicts.length === 0) {
  console.log("No generator/never_commit_paths contradiction. rc.6 will not refuse any mapping on this ground.");
} else {
  console.log(`${conflicts.length} contradiction(s) -- each becomes a blocking 'high' finding on EVERY cycle:`);
  console.log("");
  for (const c of conflicts) {
    const covering = neverCommit.filter((p) => neverCommitCovers([p], c.path));
    console.log(`  script '${c.script}' produces '${c.path}'`);
    console.log(`    excluded by never_commit_paths: ${covering.join(", ")}`);
  }
  console.log("");
  console.log("  Effect after upgrade: the path is dropped from the mapping, so nothing regenerates it");
  console.log("  AND it keeps its ordinary contract check. The run is blocked twice over.");
}

if (otherErrors.length > 0) {
  console.log("");
  console.log(`${otherErrors.length} other mapping error(s), unrelated to never_commit_paths:`);
  for (const e of otherErrors) {
    console.log(`  script '${e.script}'${e.path ? ` path '${e.path}'` : ""}: ${e.reason}`);
  }
}

const healthy = strict.entries;
if (healthy.length > 0) {
  console.log("");
  console.log(`${healthy.length} mapping(s) rc.6 accepts as-is:`);
  for (const e of healthy) {
    console.log(`  '${e.script}' -> ${[...e.files, ...e.dirs].join(", ")}${e.inputs.length || e.inputDirs.length ? ` (inputs: ${[...e.inputs, ...e.inputDirs].join(", ")})` : " (no inputs declared)"}`);
  }
}

if (conflicts.length === 0) process.exit(0);

// ---------------------------------------------------------------------------
// A narrowing proposal
// ---------------------------------------------------------------------------

/**
 * The two ways out are not equivalent, and the difference is the whole point of
 * this section.
 *
 * DELETING the excluding pattern resolves the contradiction and reintroduces
 * what the pattern was added for. `never_commit_paths` exists because workers
 * stage with `git add -A`, so a build step that regenerates a checked-in bundle
 * as a side effect sweeps the entire tree into an unrelated commit -- 141 of
 * 154 files on ProjectThanos PR #961. Those files are then counted as
 * out-of-scope writes, which is a blocking `medium` finding no worker can
 * resolve, because regenerating was the sub-task.
 *
 * NARROWING keeps that protection for everything the generators do not claim,
 * and lifts it only from the artifacts an operator has deliberately declared as
 * owned output. That is the shape the documented example already has: a
 * specific `okf/bundle.json`, not the tree it lives in.
 *
 * There is no negation in this pathspec syntax -- see `neverCommitCovers` --
 * so "everything under here except these" has to be written out as the sibling
 * paths that remain. That is what the tree scan below is for.
 */
console.log("");
console.log("--- Narrowing ---");
console.log("");
console.log("Do not simply delete the excluding pattern. It is what stops a worker's incidental");
console.log("regeneration from being swept into an unrelated commit by `git add -A` (ProjectThanos");
console.log("PR #961: 141 of 154 committed files, every one of them a blocking out-of-scope write).");
console.log("Narrow it instead, so the protection survives for everything no generator claims.");
console.log("");

const claimed = new Set();
for (const c of conflicts) claimed.add(c.path);

const implicated = neverCommit.filter((p) => [...claimed].some((path) => neverCommitCovers([p], path)));

if (!repoPath) {
  console.log("Re-run with `--repo <path>` to compute the replacement patterns against the real tree.");
  console.log(`Patterns needing attention: ${implicated.join(", ")}`);
  process.exit(1);
}

/** Every file in the tree, repo-relative, skipping .git and node_modules. */
function walk(root, dir = root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    const full = join(dir, ent.name);
    // A symlink is a LEAF, never a directory to descend into. git stores one as
    // a blob holding its target, so the thing that can be committed here is the
    // link itself and not the tree it points at. Following it would also walk
    // out of the repository -- reporting paths that are not in it -- and a link
    // to an ancestor would not terminate.
    if (ent.isSymbolicLink()) {
      out.push(relative(root, full).split(sep).join("/"));
      continue;
    }
    if (ent.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

let tree;
try {
  tree = walk(repoPath);
} catch (err) {
  console.error(`Could not scan ${repoPath}: ${err.message}`);
  process.exit(2);
}

/** Is this file one of the declared generator outputs? */
function isClaimed(file) {
  for (const path of claimed) {
    const norm = normaliseRepoPath(path);
    if (norm === null) continue;
    if (norm.endsWith("/")) {
      if (file.startsWith(norm)) return true;
    } else if (file === norm) return true;
  }
  return false;
}

for (const pattern of implicated) {
  const covered = tree.filter((f) => neverCommitCovers([pattern], f));
  const keep = covered.filter((f) => !isClaimed(f));
  const lift = covered.filter((f) => isClaimed(f));

  console.log(`Pattern '${pattern}' currently covers ${covered.length} file(s) in the tree:`);
  console.log(`  ${lift.length} declared as generator output -- the exclusion must be LIFTED from these`);
  console.log(`  ${keep.length} claimed by no generator -- the exclusion must be KEPT for these`);
  if (lift.length > 0 && lift.length <= 20) {
    for (const f of lift) console.log(`    lift: ${f}`);
  }
  if (keep.length === 0) {
    console.log("");
    console.log(`  Every file this pattern covers is declared output, so '${pattern}' can be REMOVED.`);
    console.log("  Removing it means those artifacts are committed by the worker that generates them,");
    console.log("  which is what the mappings ask for. Confirm nothing under it is sensitive first.");
    continue;
  }

  // Replacement patterns: the covered subtree, enumerated one level below the
  // point where the claimed paths sit, minus the claimed entries themselves.
  const prefixes = new Set();
  for (const f of keep) {
    const claimedDepths = [...claimed]
      .map((c) => normaliseRepoPath(c))
      .filter((c) => c !== null)
      .map((c) => c.replace(/\/$/, "").split("/").length);
    const depth = Math.max(1, Math.min(...(claimedDepths.length ? claimedDepths : [1])));
    const parts = f.split("/");
    prefixes.add(parts.length > depth ? `${parts.slice(0, depth).join("/")}/**` : f);
  }
  const proposal = [...prefixes].filter((p) => !tree.some((f) => neverCommitCovers([p], f) && isClaimed(f)));
  const stillCovered = tree.filter((f) => proposal.some((p) => neverCommitCovers([p], f)));
  const missed = keep.filter((f) => !stillCovered.includes(f));

  console.log("");
  console.log(`  Proposed replacement for '${pattern}':`);
  for (const p of proposal.sort()) console.log(`    "${p}"`);
  if (missed.length > 0) {
    console.log("");
    console.log(`  WARNING: ${missed.length} file(s) covered today would NOT be covered by that proposal,`);
    console.log("  because a generator output sits alongside them and this syntax has no negation.");
    console.log("  Those files become committable. Review them, or move the artifact out of the tree:");
    for (const f of missed.slice(0, 20)) console.log(`    exposed: ${f}`);
    if (missed.length > 20) console.log(`    ... and ${missed.length - 20} more`);
  }
  console.log("");
}

console.log("Nothing was written. Apply whichever of the above you judge correct, by hand.");
process.exit(1);
