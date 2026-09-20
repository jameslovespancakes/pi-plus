import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../store.ts";
import type { QuotaSnapshot } from "../anthropic/store.ts";

/**
 * Codex account storage.
 *
 * Deliberately a separate file from the Anthropic store rather than a shared
 * one. The two providers issue different credential shapes (Codex carries an
 * `accountId` that must accompany every request) and the Anthropic file is
 * byte-compatible with an older format we still want to be able to downgrade
 * to. Sharing one file would couple those constraints together for no gain.
 */

export interface CodexAccount {
  id: string;
  label?: string;
  enabled?: boolean;
  access?: string;
  refresh?: string;
  expires?: number;
  /** ChatGPT account id; sent as `chatgpt-account-id` on every request. */
  accountId?: string;
  /** From the token claims, e.g. "pro" or "plus". Display only. */
  plan?: string;
  addedAt?: number;
  lastRefreshedAt?: number;
  lastUsed?: number;
  blockedUntil?: number;
  quota?: QuotaSnapshot;
}

export interface CodexStorage {
  accounts: CodexAccount[];
  main?: { quota?: QuotaSnapshot; lastUsed?: number; blockedUntil?: number };
  routing?: { mode?: string };
}

export const MAIN_ACCOUNT_ID = "main";

export function codexAccountsPath(): string {
  return process.env.PI_PLUS_CODEX_ACCOUNTS_FILE ?? join(homedir(), ".pi", "agent", "codex-accounts.json");
}

export function loadCodexAccounts(path = codexAccountsPath()): CodexStorage {
  const raw = readJson<Partial<CodexStorage>>(path, {});
  return {
    accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
    main: raw?.main,
    routing: raw?.routing,
  };
}

/**
 * Atomic write (temp file + rename), matching every other store in the repo.
 *
 * A truncate-in-place `writeFileSync` here let a concurrent reader observe a
 * half-written file; `loadCodexAccounts` swallows the parse error and returns
 * an empty account list, so the next save persisted that emptiness and the
 * user's accounts disappeared. On Windows the same overlap surfaces as
 * EPERM/EBUSY. Callers that mutate credentials want to hear about a failed
 * write, so this still throws — only the per-response quota path swallows it.
 */
export function saveCodexAccounts(storage: CodexStorage, path = codexAccountsPath()): void {
  // 0600: these are live OAuth credentials.
  if (!writeJson(path, storage, true, 0o600)) {
    throw new Error(`Could not write Codex accounts to ${path}`);
  }
}

/** Inserts or replaces one account, leaving the others untouched. */
export function saveCodexAccount(account: CodexAccount, path = codexAccountsPath()): void {
  const storage = loadCodexAccounts(path);
  const index = storage.accounts.findIndex((a) => a.id === account.id);
  if (index >= 0) storage.accounts[index] = { ...storage.accounts[index], ...account };
  else storage.accounts.push(account);
  saveCodexAccounts(storage, path);
}

export function removeCodexAccount(id: string, path = codexAccountsPath()): boolean {
  const storage = loadCodexAccounts(path);
  const before = storage.accounts.length;
  storage.accounts = storage.accounts.filter((a) => a.id !== id);
  if (storage.accounts.length === before) return false;
  saveCodexAccounts(storage, path);
  return true;
}

export const isUsableCodex = (a: CodexAccount): boolean => a.enabled !== false && !!a.access;

/**
 * Reads plan and account id out of an access token.
 *
 * Codex tokens are JWTs carrying `chatgpt_plan_type` and `chatgpt_account_id`,
 * so a new account needs no extra API call to identify itself.
 */
export function claimsOf(accessToken: string | undefined): { accountId?: string; plan?: string } {
  if (!accessToken) return {};
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
    const auth = payload?.["https://api.openai.com/auth"] ?? {};
    return {
      accountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
      plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
    };
  } catch {
    return {};
  }
}
