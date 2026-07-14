// Registers the smoke-stub ESM loader for `node --import`.
// See scripts/smoke-stub.mjs for the actual stub logic.
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolve(here, "smoke-stub.mjs")).href);
