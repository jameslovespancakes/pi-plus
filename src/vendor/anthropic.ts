import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The single import point for `@cortexkit/anthropic-auth-core`.
 *
 * Nothing else in this repo may reach into the pi-managed npm tree. The old
 * code hardcoded `../npm/node_modules/@cortexkit/...` relative to the
 * extension file, which broke whenever an extension moved directory depth.
 * Resolving from the agent dir at runtime makes placement irrelevant.
 */

function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function coreEntry(): string {
  return pathToFileURL(
    join(agentDir(), "npm", "node_modules", "@cortexkit", "anthropic-auth-core", "dist", "index.js"),
  ).href;
}

export interface AnthropicAccount {
  id: string;
  label?: string;
  type: string;
  enabled?: boolean;
  access?: string;
  refresh?: string;
  expires?: number;
  addedAt?: number;
  lastRefreshedAt?: number;
  authLineageId?: string;
}

export interface AccountStorage {
  accounts: AnthropicAccount[];
}

interface AnthropicCore {
  addAccountPersistent(account: AnthropicAccount, path: string): Promise<void>;
  loadAccounts(path: string): Promise<AccountStorage | undefined>;
  authorize(mode: string): Promise<{ url: string; verifier: string; redirectUri: string; state: string }>;
  exchange(
    callback: string,
    verifier: string,
    redirectUri: string,
    state: string,
  ): Promise<{ type: string; access: string; refresh: string; expires: number }>;
  refreshClaudeOAuthToken(options: {
    refreshToken: string;
    maxRetries?: number;
    fetchImpl?: typeof fetch;
  }): Promise<{ access: string; refresh: string; expires: number }>;
  getRoutingMode(storage: unknown): string;
  setRoutingMode(mode: string, path: string): Promise<unknown>;
}

let cached: Promise<AnthropicCore> | undefined;

/** Lazily loads and memoizes the vendor core module. */
export function core(): Promise<AnthropicCore> {
  cached ??= import(coreEntry()).then((module) => module as unknown as AnthropicCore).catch((error) => {
    cached = undefined;
    throw new Error(
      `@cortexkit/anthropic-auth-core is unavailable (${error instanceof Error ? error.message : String(error)}). `
      + "Reinstall with: pi package add @cortexkit/pi-anthropic-auth",
    );
  });
  return cached;
}

/** Where the multi-account OAuth store lives. */
export function accountStoragePath(): string {
  return process.env.PI_ANTHROPIC_AUTH_FILE ?? join(agentDir(), "anthropic-auth.json");
}

export async function loadAccounts(): Promise<AccountStorage | undefined> {
  return (await core()).loadAccounts(accountStoragePath());
}

export async function saveAccount(account: AnthropicAccount): Promise<void> {
  return (await core()).addAccountPersistent(account, accountStoragePath());
}

export async function refreshToken(
  refreshTokenValue: string,
  options: { maxRetries?: number; timeoutMs?: number } = {},
): Promise<{ access: string; refresh: string; expires: number }> {
  const { refreshClaudeOAuthToken } = await core();
  return refreshClaudeOAuthToken({
    refreshToken: refreshTokenValue,
    maxRetries: options.maxRetries,
    fetchImpl: options.timeoutMs
      ? (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(options.timeoutMs!) })
      : undefined,
  });
}

export async function routingMode(): Promise<string> {
  const { getRoutingMode } = await core();
  return getRoutingMode(await loadAccounts());
}

export async function setRoutingMode(mode: "sticky-balanced" | "main-first"): Promise<string> {
  const { setRoutingMode: apply, getRoutingMode } = await core();
  return getRoutingMode(await apply(mode, accountStoragePath()));
}
