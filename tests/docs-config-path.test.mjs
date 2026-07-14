/**
 * Docs config-path integrity test.
 *
 * Every `jsonc` (or `json`) config example in the docs must show the
 * plugin config under `plugins.entries["openclaw-agent-harness"].config`.
 * This is the standard OpenClaw plugin config path (same as
 * openclaw-hybrid-memory) and is what the plugin reads via
 * `api.pluginConfig` at runtime.
 *
 * Regression this catches: earlier docs used a top-level `harness:`
 * block (YAML) or `plugins["openclaw-agent-harness"]` (missing
 * `.entries` and `.config`), both of which lead to
 * "slack.channel is required" style errors on boot because the plugin
 * never sees the config.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DOC_FILES = [
  "docs/CONFIGURATION.md",
  "docs/REAL-TEST-RUNBOOK.md",
];

function stripJsonc(s) {
  // Remove line comments (//...) that make jsonc invalid JSON.
  s = s.replace(/\/\/[^\n]*/g, "");
  // Remove trailing commas before `}` or `]`.
  s = s.replace(/,(\s*[}\]])/g, "$1");
  return s;
}

function extractBlocks(md) {
  const blocks = [];
  const re = /```(?:jsonc|json)\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1]);
  return blocks;
}

function walk(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

for (const file of DOC_FILES) {
  const full = resolve(repoRoot, file);
  test(`docs: ${file} config blocks parse and use plugins.entries[...].config`, { skip: !existsSync(full) }, () => {
    const md = readFileSync(full, "utf8");
    const blocks = extractBlocks(md);
    assert.ok(blocks.length > 0, `${file} contains no jsonc/json code blocks`);
    for (let i = 0; i < blocks.length; i++) {
      const raw = blocks[i];
      let parsed;
      try {
        parsed = JSON.parse(stripJsonc(raw));
      } catch (err) {
        assert.fail(`${file} block ${i} is not valid JSON: ${err.message}\n---\n${raw.slice(0, 400)}\n---`);
      }
      // Every config example in these docs must be rooted at
      // plugins.entries["openclaw-agent-harness"].config.
      const cfg = walk(parsed, ["plugins", "entries", "openclaw-agent-harness", "config"]);
      assert.ok(
        cfg !== undefined,
        `${file} block ${i} does not have plugins.entries["openclaw-agent-harness"].config path. Top-level keys: ${JSON.stringify(Object.keys(parsed))}`,
      );
      assert.equal(
        typeof cfg,
        "object",
        `${file} block ${i}: plugins.entries[...].config must be an object`,
      );
    }
  });
}
