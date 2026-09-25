#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, process.argv[2] ?? "plugin-entry/index.js");
const require = createRequire(import.meta.url);
const claudeSdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");

// The adapter dynamically imports the SDK namespace but only calls `query`.
// Redirect that one build edge through a static re-export so esbuild can omit
// the SDK's unrelated public exports from the activation artifact. Runtime
// source and the ordinary dist/ entry remain unchanged.
const claudeSdkQueryOnly = {
  name: "claude-sdk-query-only",
  setup(context) {
    context.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
      path: "query-only",
      namespace: "claude-sdk-query-only",
    }));
    context.onLoad({ filter: /^query-only$/, namespace: "claude-sdk-query-only" }, () => ({
      contents: `export { query } from ${JSON.stringify(claudeSdkEntry)};`,
      loader: "js",
      resolveDir: root,
    }));
  },
};

mkdirSync(dirname(outfile), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["dist/index.js"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["openclaw", "openclaw/*"],
  plugins: [claudeSdkQueryOnly],
  treeShaking: true,
  // Minify identifiers and whitespace, but retain source-level syntax shapes.
  // Together with keepNames and bounded lines this keeps stack inspection useful
  // while avoiding the activation-time parse cost of the unminified bundle.
  minifyIdentifiers: true,
  minifyWhitespace: true,
  minifySyntax: false,
  keepNames: true,
  lineLimit: 120,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});
