#!/usr/bin/env node
/**
 * Report how `verify.generators` and `repos.never_commit_paths` interact in a
 * deployment, before a run has to discover it.
 *
 * HISTORY, BECAUSE THE ANSWER REVERSED. rc.6 refused a `produces` path that the
 * exclusion list also covered, on the grounds that no worker could satisfy the
 * contract: the generator is told to write the file, the exclusion unstages AND
 * restores it before the commit, the contract fails because the artifact was
 * never committed, and the advice ("run the generator") loses to the same
 * revert next cycle. This script was written to help operators narrow the
 * exclusion list out of that corner.
 *
 * rc.7 removed the premise instead. The exclusion now spares whatever the
 * committing sub-task is contracted to generate, so the overlap is no longer a
 * contradiction -- it is the configuration an operator with a checked-in
 * generated bundle actually wants, and the narrowing this script used to
 * propose is not merely unnecessary but harmful: enumerating siblings loses
 * protection for every directory added later, which the blanket pattern covered
 * for free.
 *
 * So this now reports OWNERSHIP COVERAGE. The question worth asking of such a
 * config is no longer "do these overlap" (fine) but "is every excluded path
 * that something must commit actually owned by a declared generator" -- because
 * an excluded path that no generator owns can never be committed by anyone, and
 * that is the case that still cannot be satisfied.
 *
 * READ-ONLY BY CONSTRUCTION. Opens the config and, optionally, the repository
 * tree. Writes to neither.
 *
 * Usage:
 *   node scripts/generator-config-preflight.mjs <config.json> [--repo <path>]
 *
 * <config.json> may be a whole `~/.openclaw/openclaw.json` or just the plugin's
 * own config block; both shapes are recognised.
 *
 * Exit status is 1 when a mapping is rejected outright, since that is still a
 * configuration fault that blocks runs. An overlap on its own is not.
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

const map = resolveGenerators(generators);

// ---------------------------------------------------------------------------
// Mapping faults -- still real, still blocking
// ---------------------------------------------------------------------------

if (map.errors.length > 0) {
  console.log(`${map.errors.length} rejected mapping(s). Each becomes a blocking 'high' finding on EVERY cycle,`);
  console.log("and the affected paths are left unowned -- no generation, and no exemption either:");
  console.log("");
  for (const e of map.errors) {
    console.log(`  script '${e.script}'${e.path ? ` path '${e.path}'` : ""}`);
    console.log(`    ${e.reason}`);
  }
  console.log("");
}

if (map.entries.length > 0) {
  console.log(`${map.entries.length} mapping(s) resolve cleanly:`);
  for (const e of map.entries) {
    const owns = [...e.files, ...e.dirs].join(", ");
    const inputs = [...e.inputs, ...e.inputDirs];
    console.log(`  '${e.script}' -> ${owns}${inputs.length ? ` (inputs: ${inputs.join(", ")})` : " (no inputs declared)"}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Ownership coverage
// ---------------------------------------------------------------------------

if (neverCommit.length === 0 || map.empty) {
  console.log("No exclusion list, or no resolved generator: there is no interaction to report.");
  process.exit(map.errors.length > 0 ? 1 : 0);
}

const owned = [];
for (const e of map.entries) {
  for (const p of [...e.files, ...e.dirs]) {
    if (neverCommitCovers(neverCommit, p)) owned.push({ path: p, script: e.script });
  }
}

console.log("--- Ownership coverage ---");
console.log("");
if (owned.length === 0) {
  console.log("No declared output is covered by the exclusion list. Nothing to reconcile.");
} else {
  console.log(`${owned.length} declared output(s) are covered by the exclusion list. Since rc.7 that is FINE:`);
  console.log("the exclusion spares whichever sub-task is contracted to generate the path, and still reverts");
  console.log("it for every other turn -- which is the sweep the list was added to stop. No config edit is");
  console.log("needed, and narrowing the list by hand would lose protection for anything added later.");
  console.log("");
  for (const o of owned) console.log(`  ${o.path} -- owned by '${o.script}'`);
}

if (!repoPath) {
  console.log("");
  console.log("Re-run with `--repo <path>` to find excluded files that NO generator owns.");
  process.exit(map.errors.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// The case that still cannot be satisfied
// ---------------------------------------------------------------------------

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

const covered = tree.filter((f) => neverCommitCovers(neverCommit, f));
const unowned = covered.filter((f) => map.ownerOf(f) === null);

console.log("");
console.log(`Excluded files in this checkout: ${covered.length}`);
console.log(`  owned by a generator (committable by the sub-task that owns them): ${covered.length - unowned.length}`);
console.log(`  owned by nothing (revert applies to every turn):                   ${unowned.length}`);

if (unowned.length > 0) {
  console.log("");
  console.log("The unowned files are the ones no run can ever commit. That is usually correct -- it is");
  console.log("what the exclusion list is for. It is only a problem if a sub-task's contract requires");
  console.log("one of them, which presents as a generator that 'did not run'. Worth a look if you see");
  console.log("that failure on a path listed here:");
  for (const f of unowned.slice(0, 20)) console.log(`    ${f}`);
  if (unowned.length > 20) console.log(`    ... and ${unowned.length - 20} more`);
}

console.log("");
console.log("Nothing was written.");
process.exit(map.errors.length > 0 ? 1 : 0);
