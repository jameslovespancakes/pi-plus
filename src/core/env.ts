import { readConfig, resetConfigCache, updateConfig } from "./config.ts";

/**
 * Credentials and endpoints, stored in the `env` section of `pi-plus.json`.
 *
 * Precedence is `process.env` first, then the file. That keeps CI and one-off
 * shell overrides working exactly as people expect, while giving the TUI a
 * single place to read and write.
 */

export type EnvKey =
  | "ARTIFICIAL_ANALYSIS_API_KEY"
  | "AGENT_BOARD_URL"
  | "AGENT_BOARD_TOKEN"
  | "AGENT_BOARD_NAME"
  | "AGENT_BOARD_MODE"
  | "AGENT_BOARD_SSH";

export const ENV_KEYS: { key: EnvKey; label: string; secret: boolean }[] = [
  { key: "ARTIFICIAL_ANALYSIS_API_KEY", label: "Artificial Analysis API key", secret: true },
  { key: "AGENT_BOARD_URL", label: "Agent board URL", secret: false },
  { key: "AGENT_BOARD_TOKEN", label: "Agent board token", secret: true },
  { key: "AGENT_BOARD_NAME", label: "Agent board display name", secret: false },
  { key: "AGENT_BOARD_MODE", label: "Agent board deployment (local|remote|external)", secret: false },
  { key: "AGENT_BOARD_SSH", label: "Agent board SSH host, when remote", secret: false },
];

/** Reads a setting: real environment first, then the config file. */
export function env(key: EnvKey): string | undefined {
  const fromProcess = process.env[key];
  if (typeof fromProcess === "string" && fromProcess.trim()) return fromProcess.trim();
  const value = readConfig().env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Writes a setting. Passing undefined or blank removes it. */
export function setEnv(key: EnvKey, value: string | undefined): boolean {
  return updateConfig((config) => {
    if (value === undefined || value.trim() === "") delete config.env[key];
    else config.env[key] = value.trim();
  });
}

/** True when the real environment supplies this key, so the file is ignored. */
export function isFromProcessEnv(key: EnvKey): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim() !== "";
}

/** `aa_vaoi…rXcC`: enough to recognise, not enough to use. */
export function maskSecret(value: string): string {
  if (value.length <= 10) return "•".repeat(value.length);
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

export function resetEnvCache(): void {
  resetConfigCache();
}
