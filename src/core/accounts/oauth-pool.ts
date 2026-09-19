import type { OAuthCredential } from "@earendil-works/pi-ai";
import { agentPath, readJson, writeJson } from "../store.ts";

export type OAuthPoolMode = "standard" | "optimal";

export interface PooledOAuthAccount extends OAuthCredential {
  id: string;
  label: string;
  enabled?: boolean;
  identity?: string;
  addedAt: number;
  lastUsed?: number;
}

export interface ProviderOAuthPool {
  accounts: PooledOAuthAccount[];
  mode: OAuthPoolMode;
}

interface OAuthPoolFile {
  version: 1;
  providers: Record<string, ProviderOAuthPool>;
}

const EMPTY_FILE: OAuthPoolFile = { version: 1, providers: {} };
const DEFAULT_PATH = "pi-plus-oauth-accounts.json";
const fileCache = new Map<string, OAuthPoolFile>();

export function oauthPoolPath(): string {
  return process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE ?? agentPath(DEFAULT_PATH);
}

function loadFile(path = oauthPoolPath()): OAuthPoolFile {
  const cached = fileCache.get(path);
  if (cached) return cached;

  const raw = readJson<Partial<OAuthPoolFile>>(path, EMPTY_FILE);
  const file: OAuthPoolFile = {
    version: 1,
    providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
  };
  fileCache.set(path, file);
  return file;
}

function saveFile(file: OAuthPoolFile, path = oauthPoolPath()): void {
  fileCache.set(path, file);
  if (!writeJson(path, file, true, 0o600)) throw new Error(`Could not write OAuth accounts to ${path}`);
}

export function loadOAuthPool(providerId: string, path = oauthPoolPath()): ProviderOAuthPool {
  const pool = loadFile(path).providers[providerId];
  return {
    accounts: Array.isArray(pool?.accounts) ? pool.accounts : [],
    mode: pool?.mode === "optimal" ? "optimal" : "standard",
  };
}

export function saveOAuthPool(providerId: string, pool: ProviderOAuthPool, path = oauthPoolPath()): void {
  const file = loadFile(path);
  file.providers[providerId] = pool;
  saveFile(file, path);
}

export function saveOAuthAccount(providerId: string, account: PooledOAuthAccount, path = oauthPoolPath()): void {
  const pool = loadOAuthPool(providerId, path);
  const index = pool.accounts.findIndex((candidate) => candidate.id === account.id);
  if (index === -1) pool.accounts.push(account);
  else pool.accounts[index] = { ...pool.accounts[index], ...account };
  saveOAuthPool(providerId, pool, path);
}

export function removeOAuthAccount(providerId: string, accountId: string, path = oauthPoolPath()): boolean {
  const pool = loadOAuthPool(providerId, path);
  const accounts = pool.accounts.filter((account) => account.id !== accountId);
  if (accounts.length === pool.accounts.length) return false;
  saveOAuthPool(providerId, { ...pool, accounts }, path);
  return true;
}

export function setOAuthPoolMode(providerId: string, mode: OAuthPoolMode, path = oauthPoolPath()): void {
  saveOAuthPool(providerId, { ...loadOAuthPool(providerId, path), mode }, path);
}

export function oauthIdentity(access: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    for (const key of ["sub", "email", "account_id", "user_id", "uid"]) {
      const value = payload[key];
      if (typeof value === "string" && value) return `${key}:${value}`;
    }
  } catch {
    // Opaque access tokens have no local identity.
  }
  return undefined;
}

export function resetOAuthPoolCache(): void {
  fileCache.clear();
}
