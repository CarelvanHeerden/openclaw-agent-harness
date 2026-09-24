import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const retired = [
  "orchestrator/budget-extension",
  "orchestrator/time-extension",
  "slack/channel-listener",
  "slack/dispatcher",
];

test("retired interactive modules are absent from source and built output", () => {
  for (const module of retired) {
    assert.equal(existsSync(resolve(root, `src/${module}.ts`)), false, `src/${module}.ts`);
    assert.equal(existsSync(resolve(root, `dist/${module}.js`)), false, `dist/${module}.js`);
    assert.equal(existsSync(resolve(root, `dist/${module}.d.ts`)), false, `dist/${module}.d.ts`);
  }
});

test("the exact npm payload excludes retired interactive modules", () => {
  const snapshot = mkdtempSync(resolve(tmpdir(), "oah-pack-snapshot-"));
  try {
    for (const path of ["package.json", "LICENSE", "README.md", "openclaw.plugin.json", "dist", "docs", "scripts"]) {
      cpSync(resolve(root, path), resolve(snapshot, path), { recursive: true });
    }
    const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: snapshot,
      encoding: "utf8",
    }));
    const artifact = packed[0] ?? Object.values(packed)[0];
    const files = artifact.files.map(({ path }) => path);
    for (const module of retired) {
      assert.ok(!files.some((path) => path.startsWith(`dist/${module}.`)), `${module} leaked into npm payload`);
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
});

test("public config and Slack deployment expose no extension, listener, or reaction controls", () => {
  const schema = JSON.parse(read("src/config.schema.json"));
  const manifest = JSON.parse(read("openclaw.plugin.json")).configSchema;
  const goneLoop = [
    "time_extension_ask_enabled",
    "time_extension_wait_seconds",
    "time_extension_default_seconds",
    "budget_extension_ask_enabled",
    "budget_extension_wait_seconds",
  ];
  for (const publicSchema of [schema, manifest]) {
    assert.equal(publicSchema.properties.slack.properties.listener_enabled, undefined);
    for (const key of goneLoop) assert.equal(publicSchema.properties.loop.properties[key], undefined, key);
  }
  const slackManifest = read("deploy/slack-app-manifest.yaml");
  assert.doesNotMatch(slackManifest, /reaction_added|reaction_removed|reactions:(?:read|write)|event_subscriptions|interactivity|slash_commands/);
  assert.match(slackManifest, /chat:write/);
});

test("control-plane documentation matches the v2 running response", () => {
  const doc = read("docs/CONTROL-PLANE.md");
  assert.match(doc, /control-plane-confirm\/v2/);
  assert.match(doc, /"state": "running"/);
  assert.match(doc, /"summary": "Change confirmed and running autonomously\."/);
  assert.doesNotMatch(doc, /`accepted`/);
});
