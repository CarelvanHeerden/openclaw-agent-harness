import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkerAcp } from "../dist/adapters/acp.js";
import { CredentialVault } from "../dist/adapters/credential-vault.js";
import { buildProviderBlock } from "../dist/adapters/role-config.js";
import { openCodeConfigEnv } from "../dist/adapters/opencode-config.js";
import { buildAcpGuard } from "../dist/safety/bash-guard.js";
import { focusedWorkerAcpGuard } from "../dist/safety/focused-worker-acp-guard.js";

const home = process.env.HOME;
const config = JSON.parse(readFileSync(join(home, ".harness-local/config.json"), "utf8"));
const vault = CredentialVault.open({
  dir: join(home, ".harness-local/harness-vault"),
  logger: { info() {}, warn() {} },
});
const { block } = buildProviderBlock(config.providers ?? {}, (service) =>
  vault.get(service, "api_key"),
);
const model = process.argv[2] ?? "openai/gpt-5.3-codex";
const efforts = (process.argv[3] ?? "none,medium,high").split(",");
const useChecklist = process.argv[4] === "checklist";

try {
  for (const effort of efforts) {
    const cwd = mkdtempSync(join(tmpdir(), `oah-effort-${effort}-`));
    try {
      const out = await runWorkerAcp({
        agent: {
          command: "opencode",
          args: ["acp"],
          env: openCodeConfigEnv({ provider: block, model, toolless: false }),
        },
        worktreePath: cwd,
        systemPrompt:
          "You are a file-edit probe. " +
          (useChecklist ? "First record a short plan with your todo/checklist tool. " : "") +
          "Use a direct file edit/write tool to create probe.txt " +
          "containing exactly PASS followed by a newline. Do not use subagents. Do not merely " +
          "describe the edit. End only after reading the file back.",
        userMessage: "Create probe.txt now.",
        model,
        effort,
        timeoutSeconds: 120,
        streamOpenTimeoutSeconds: 30,
        firstTokenTimeoutSeconds: 30,
        acpGuard: focusedWorkerAcpGuard(buildAcpGuard({
          bash_whitelist: ["cat", "printf", "echo", "ls"],
          bash_denylist_tokens: ["sudo", "rm"],
          path_denylist: [".env", "*.pem"],
          allow_git_push: false,
          allow_network_commands: false,
        })),
      });
      let content = "";
      try {
        content = readFileSync(join(cwd, "probe.txt"), "utf8");
      } catch {}
      console.log(JSON.stringify({
        effort,
        wrote: content === "PASS\n",
        stopReason: out.stopReason,
        denied: out.deniedToolCalls.length,
        costUsd: out.costUsd,
        finalMessage: out.finalMessage.slice(0, 160),
      }));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
} finally {
  vault.close();
}
