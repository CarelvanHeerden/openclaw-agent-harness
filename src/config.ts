/**
 * Plugin configuration types. Runtime validation lives in `config.schema.json`
 * (loaded by OpenClaw's plugin loader) and mirrors this file.
 */

export interface HarnessConfig {
  slack: SlackConfig;
  budgets: BudgetsConfig;
  repos: ReposConfig;
  models: ModelsConfig;
  loop: LoopConfig;
  vercel: VercelConfig;
  storage: StorageConfig;
  safety: SafetyConfig;
  pat_routing: PatRoutingConfig;
}

export interface SlackConfig {
  channel: string;
  authorised_users: string[];
  reactions: {
    ship_it: string;
    abort: string;
    pause: string;
    budget_bump: string;
  };
}

export interface BudgetsConfig {
  monthly_per_user_usd: number;
  session_default_usd: number;
  session_hard_ceiling_usd: number;
  daily_warn_usd: number;
  monthly_warn_ratio: number;
}

export interface ReposConfig {
  allowed: string[];
  can_create: boolean;
  create_org: string;
  create_visibility: "private" | "public";
  default_branch: string;
}

export interface ModelsConfig {
  lead: string;
  worker: string;
  adversary: string;
  classifier: string;
}

export interface LoopConfig {
  max_cycles: number;
  adversarial_pass_ends_early: boolean;
  worker_timeout_seconds: number;
  adversary_timeout_seconds: number;
}

export interface VercelConfig {
  enabled: boolean;
  credential_service?: string;
  team?: string;
  project?: string;
}

export interface StorageConfig {
  state_db_path: string;
  worktrees_root: string;
  audit_retention_days: number;
}

export interface SafetyConfig {
  worker_permission_mode: "acceptEdits" | "bypassPermissions" | "plan";
  bash_whitelist: string[];
  bash_denylist_patterns: string[];
  path_denylist: string[];
}

export interface PatRoutingConfig {
  overrides: Record<string, Record<string, string>>;
  commit_identity: Record<string, { name: string; email: string }>;
}
