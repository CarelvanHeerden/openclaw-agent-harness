// Keep the rc.11 real-git scenarios in one Node test process. The repository's
// `tests/*.mjs` command runs files in parallel; four additional scenario
// processes intermittently exhausted macOS spawn resources and produced
// `spawn git ENOENT`, which is not a product failure.
await import("./rc11/contract-amendment.mjs");
await import("./rc11/outcome-acp-authority.mjs");
await import("./rc11/observe-contract.mjs");
await import("./rc11/accounting-terminal-compat.mjs");
