#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(root, "src", "config.schema.json");
const manifestPath = join(root, "openclaw.plugin.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (process.argv.includes("--check")) {
  if (JSON.stringify(manifest.configSchema) !== JSON.stringify(schema)) {
    console.error("openclaw.plugin.json configSchema differs from src/config.schema.json; run npm run schema:sync");
    process.exit(1);
  }
  console.log("configuration schemas are semantically identical");
} else {
  manifest.configSchema = schema;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log("generated openclaw.plugin.json configSchema from src/config.schema.json");
}
