// docs/CONFIGURATION.md headed a section "Full reference" and documented 59 of
// 165 keys. Seven of the absent ones default to off, two of those are
// `safety.allow_git_push` and `safety.allow_network_commands`, and beta.136 had
// already been spent writing up two others after a real run cost $22.67 and 92
// minutes discovering one of them was unset.
//
// The appendix is now generated from the manifest, so the failure mode moves
// from "someone forgets to document a key" to "someone forgets to regenerate",
// which a test can catch. This is that test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderReference, resolvedDefaults, START, END } from "../scripts/gen-config-reference.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(root, "docs", "CONFIGURATION.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));

function committedBlock() {
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  assert.ok(a !== -1 && b !== -1, "docs/CONFIGURATION.md must carry the generated-reference markers");
  return doc.slice(a, b + END.length);
}

test("the generated config reference in the docs is current", async () => {
  const rendered = renderReference(manifest, await resolvedDefaults());
  assert.equal(
    committedBlock(),
    rendered,
    "docs/CONFIGURATION.md is out of date with openclaw.plugin.json. Run `npm run docs:config`.",
  );
});

test("every key the gateway accepts is documented, not merely most of them", async () => {
  const rendered = renderReference(manifest, await resolvedDefaults());
  const documented = new Set([...rendered.matchAll(/^- \*\*`([^`]+)`\*\*/gm)].map((m) => m[1]));

  const leaves = (node, path = []) => {
    if (!node || typeof node !== "object") return [];
    if (!node.properties) return path.length ? [path.join(".")] : [];
    return Object.entries(node.properties).flatMap(([k, v]) => leaves(v, [...path, k]));
  };

  const missing = leaves(manifest.configSchema).filter((k) => !documented.has(k));
  assert.deepEqual(missing, [], `undocumented config keys: ${missing.join(", ")}`);
});

test("the safety settings that default to off are documented, since nothing else warns you", async () => {
  const rendered = renderReference(manifest, await resolvedDefaults());
  for (const key of [
    "safety.allow_git_push",
    "safety.allow_network_commands",
    "safety.path_denylist",
    "repos.never_commit_paths",
    "brief.request_file_roots",
  ]) {
    assert.ok(rendered.includes(`**\`${key}\`**`), `${key} must appear in the generated reference`);
  }
});
