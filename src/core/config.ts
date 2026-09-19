import { existsSync } from "node:fs";
import { agentPath, readJson, writeJson } from "./store.ts";

/**
 * One file for everything pi-plus owns: `~/.pi/agent/pi-plus.json`.
 *
 * ```json
 * {
 *   "env":    { "ARTIFICIAL_ANALYSIS_API_KEY": "aa_…", "AGENT_BOARD_URL": "…" },
 *   "policy": { "autoApprove": [], "requireApproval": [], "deny": [] },
 *   "remote": { "injectStatus": true, "defaults": {}, "workers": [] }
 * }
 * ```
 *
 * Pi's own `settings.json` and `models.json` are deliberately NOT absorbed:
 * pi reads those from fixed paths and folding them in here would break it.
 *
 * Every legacy file is migrated on first read and left on disk, so downgrading
 * keeps working.
 */

export const CONFIG_FILE = "pi-plus.json";

export interface PolicySection {
  autoApprove: string[];
  requireApproval: string[];
  deny: string[];
}

export interface RemoteSection {
  injectStatus?: boolean;
  defaults?: Record<string, unknown>;
  workers: Record<string, unknown>[];
}

export interface PiPlusConfig {
  env: Record<string, string>;
  policy: PolicySection;
  remote: RemoteSection;
}

const DEFAULTS: PiPlusConfig = {
  env: {},
  policy: {
    autoApprove: ["anthropic/*", "openai-codex/*"],
    requireApproval: ["openrouter/*", "google/*", "openai/*", "xai/*"],
    deny: [],
  },
  remote: { injectStatus: true, workers: [] },
};

/** Legacy file -> section, applied only when that section is still absent. */
const MIGRATIONS: { file: string; apply: (raw: any, into: PiPlusConfig) => boolean }[] = [
  {
    file: "pi-plus.env.json",
    apply: (raw, into) => {
      if (Object.keys(into.env).length > 0 || !raw || typeof raw !== "object") return false;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value.trim()) into.env[key] = value.trim();
      }
      return true;
    },
  },
  {
    file: "model-quality-key.json",
    apply: (raw, into) => {
      if (into.env.ARTIFICIAL_ANALYSIS_API_KEY || typeof raw?.artificialAnalysis !== "string") return false;
      into.env.ARTIFICIAL_ANALYSIS_API_KEY = raw.artificialAnalysis;
      return true;
    },
  },
  {
    file: "agent-board.json",
    apply: (raw, into) => {
      if (into.env.AGENT_BOARD_URL || typeof raw?.url !== "string" || typeof raw?.token !== "string") return false;
      into.env.AGENT_BOARD_URL = raw.url;
      into.env.AGENT_BOARD_TOKEN = raw.token;
      if (typeof raw.adminName === "string") into.env.AGENT_BOARD_NAME ??= raw.adminName;
      return true;
    },
  },
  {
    file: "model-policy.json",
    apply: (raw, into) => {
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.requireApproval)) return false;
      into.policy = {
        autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove : DEFAULTS.policy.autoApprove,
        requireApproval: raw.requireApproval,
        deny: Array.isArray(raw.deny) ? raw.deny : [],
      };
      return true;
    },
  },
  {
    file: "remote.json",
    apply: (raw, into) => {
      if (into.remote.workers.length > 0 || !Array.isArray(raw?.workers)) return false;
      into.remote = { injectStatus: raw.injectStatus !== false, defaults: raw.defaults, workers: raw.workers };
      return true;
    },
  },
  {
    file: "remote-workers.json",
    apply: (raw, into) => {
      if (into.remote.workers.length > 0 || !Array.isArray(raw?.workers)) return false;
      into.remote = { injectStatus: raw.injectStatus !== false, defaults: raw.defaults, workers: raw.workers };
      return true;
    },
  },
];

let cache: PiPlusConfig | undefined;

export function configPath(): string {
  return process.env.PI_PLUS_CONFIG ?? agentPath(CONFIG_FILE);
}

function normalize(raw: Partial<PiPlusConfig> | undefined): PiPlusConfig {
  return {
    env: raw?.env && typeof raw.env === "object" ? { ...raw.env } : {},
    policy: {
      autoApprove: Array.isArray(raw?.policy?.autoApprove) ? raw.policy.autoApprove : DEFAULTS.policy.autoApprove,
      requireApproval: Array.isArray(raw?.policy?.requireApproval)
        ? raw.policy.requireApproval
        : DEFAULTS.policy.requireApproval,
      deny: Array.isArray(raw?.policy?.deny) ? raw.policy.deny : [],
    },
    remote: {
      injectStatus: raw?.remote?.injectStatus !== false,
      defaults: raw?.remote?.defaults,
      workers: Array.isArray(raw?.remote?.workers) ? raw.remote.workers : [],
    },
  };
}

export function readConfig(): PiPlusConfig {
  if (cache) return cache;

  const path = configPath();
  const exists = existsSync(path);
  const config = normalize(exists ? readJson<Partial<PiPlusConfig>>(path, {}) : undefined);

  // Only consider legacy sources when the unified file is absent or partial.
  let migrated = false;
  for (const migration of MIGRATIONS) {
    const legacyPath = agentPath(migration.file);
    if (!existsSync(legacyPath)) continue;
    const raw = readJson<any>(legacyPath, undefined);
    if (raw === undefined) continue;
    if (migration.apply(raw, config)) migrated = true;
  }

  if (!exists || migrated) writeJson(path, config, true);
  cache = config;
  return config;
}

/** Read-modify-write of the whole file, so sections never clobber each other. */
export function updateConfig(mutate: (config: PiPlusConfig) => void): boolean {
  const config = readConfig();
  mutate(config);
  cache = config;
  return writeJson(configPath(), config, true);
}

/** Drops the in-memory copy. Used by tests and after external edits. */
export function resetConfigCache(): void {
  cache = undefined;
}
