import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeRoutingMode, type AccountRoutingMode } from "../accounts/routing.ts";

/**
 * Anthropic account store.
 *
 * Keeps durable identity in `anthropic-auth.json` and live secrets and quota
 * in `anthropic-auth-state.json`.
 *
 *   anthropic-auth.json        id, label, type, enabled, addedAt, routing
 *   anthropic-auth-state.json  access, refresh, expires, quota, lastUsed, ...
 *
 * Keeping secrets out of the config file means the config can be inspected,
 * diffed or backed up without exposing tokens.
 */

export const CONFIG_FILE = "anthropic-auth.json";
export const STATE_FILE = "anthropic-auth-state.json";

export interface QuotaWindow {
  remainingPercent?: number;
  usedPercent?: number;
  resetsAt?: string;
  checkedAt?: number;
  id?: string;
}

export interface QuotaSnapshot {
  five_hour?: QuotaWindow;
  seven_day?: QuotaWindow;
  scoped?: QuotaWindow[];
  checkedAt?: number;
  source?: "poll" | "headers";
  [key: string]: unknown;
}

export interface Account {
  id: string;
  label?: string;
  type: "oauth" | "api";
  enabled?: boolean;
  addedAt?: number;
  // state-file fields
  access?: string;
  refresh?: string;
  expires?: number;
  lastUsed?: number;
  lastRefreshedAt?: number;
  authLineageId?: string;
  quota?: QuotaSnapshot;
  apiKey?: string;
}

export type RoutingMode = AccountRoutingMode;

export interface Storage {
  version?: number;
  mainAccountId?: string;
  main?: Record<string, unknown>;
  accounts: Account[];
  routing?: { mode?: RoutingMode };
  [key: string]: unknown;
}

/** Fields that belong in the durable config file. */
const CONFIG_FIELDS = ["id", "label", "type", "enabled", "addedAt", "baseURL", "authHeader"] as const;
/** Fields that belong in the state file. */
const STATE_FIELDS = [
  "authLineageId", "access", "refresh", "expires", "lastUsed",
  "lastRefreshedAt", "lastRefreshError", "lastQuotaRefreshError", "quota", "profile", "prime", "apiKey",
] as const;

function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return process.env.PI_ANTHROPIC_AUTH_FILE ?? join(agentDir(), CONFIG_FILE);
}

export function statePath(config = configPath()): string {
  return config.endsWith(CONFIG_FILE) ? join(dirname(config), STATE_FILE) : `${config}.state.json`;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Temp-file + rename, so a crash cannot leave a half-written credential file.
 *
 * The rename is retried because on Windows it fails with EPERM whenever the
 * destination is momentarily held open by someone else: a virus scanner
 * examining the file we just wrote, the search indexer, or another pi session
 * reading it. The temp name carries the pid so concurrent writers never share
 * a temp file, but they can still collide on the destination.
 *
 * Retries are brief and synchronous. Losing a quota update is harmless, so a
 * final failure removes the temp file and gives up rather than throwing into
 * a live request.
 */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, undefined, 2), { encoding: "utf8", mode: 0o600 });

  const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error: any) {
      if (attempt >= 5 || !TRANSIENT.has(error?.code)) {
        try { rmSync(temp, { force: true }); } catch { /* best effort */ }
        if (attempt >= 5) return; // transient and unresolved: drop this write
        throw error;
      }
      // 1, 2, 4, 8, 16ms. Long enough for a scanner to release the handle,
      // short enough not to stall the request that triggered it.
      Atomics.wait(SPIN, 0, 0, 2 ** attempt);
    }
  }
}

/** Backing store for the synchronous sleep above. */
const SPIN = new Int32Array(new SharedArrayBuffer(4));

const pick = <T extends object>(source: any, keys: readonly string[]): T =>
  Object.fromEntries(keys.filter((k) => source?.[k] !== undefined).map((k) => [k, source[k]])) as T;

export function emptyStorage(): Storage {
  return { version: 1, accounts: [], routing: { mode: "sequential" } };
}

/**
 * Reads both files and rejoins them into whole accounts.
 *
 * A state file can exist without a config file: a main-account refresh writes
 * state but never touches config. Returns undefined only when neither exists.
 */
export function loadAccounts(config = configPath()): Storage | undefined {
  const cfg = readJson<Storage>(config);
  const state = readJson<{ main?: any; accounts?: Record<string, any> }>(statePath(config));
  if (!cfg && !state) return undefined;

  const base: Storage = cfg ?? emptyStorage();
  const byId = state?.accounts ?? {};

  return {
    ...base,
    main: { ...(base.main ?? {}), ...(state?.main ?? {}) },
    accounts: (base.accounts ?? []).map((account) => ({ ...account, ...(byId[account.id] ?? {}) })),
  };
}

/** Writes both files, routing each field to the correct one. */
export function saveAccounts(storage: Storage, config = configPath()): void {
  const existingCfg = readJson<Record<string, unknown>>(config) ?? {};
  const existingState = readJson<Record<string, any>>(statePath(config)) ?? {};

  const cfg = {
    ...existingCfg,
    ...storage,
    version: storage.version ?? 1,
    accounts: storage.accounts.map((a) => pick(a, CONFIG_FIELDS)),
  };
  delete (cfg as any).main;

  const state = {
    ...existingState,
    version: 1,
    main: storage.main && Object.keys(storage.main).length ? storage.main : undefined,
    accounts: Object.fromEntries(storage.accounts.map((a) => [a.id, pick(a, STATE_FIELDS)])),
  };
  if (state.main === undefined) delete state.main;

  writeJson(config, cfg);
  writeJson(statePath(config), state);
}

/** Inserts or replaces one account, leaving every other account untouched. */
export function saveAccount(account: Account, config = configPath()): void {
  const storage = loadAccounts(config) ?? emptyStorage();
  const index = storage.accounts.findIndex((a) => a.id === account.id);
  if (index >= 0) storage.accounts[index] = { ...storage.accounts[index], ...account };
  else storage.accounts.push(account);
  saveAccounts(storage, config);
}

export function removeAccount(id: string, config = configPath()): boolean {
  const storage = loadAccounts(config);
  if (!storage) return false;
  const before = storage.accounts.length;
  storage.accounts = storage.accounts.filter((a) => a.id !== id);
  if (storage.accounts.length === before) return false;
  saveAccounts(storage, config);
  return true;
}

export const isOAuthAccount = (a: Account): boolean => a.type === "oauth" && !!a.refresh;
export const isUsable = (a: Account): boolean => a.enabled !== false && isOAuthAccount(a);

export function getRoutingMode(storage: Storage | undefined): RoutingMode {
  return normalizeRoutingMode(storage?.routing?.mode as string | undefined);
}

export function setRoutingMode(mode: RoutingMode, config = configPath()): Storage {
  const storage = loadAccounts(config) ?? emptyStorage();
  storage.routing = { ...(storage.routing ?? {}), mode };
  saveAccounts(storage, config);
  return storage;
}

/**
 * The pseudo-account id for pi's own Anthropic credential.
 *
 * `main` is NOT one of `storage.accounts`. Its tokens live in pi's `auth.json`
 * and reach the provider as the primary access token at request time;
 * `mainAccountId` is only a stable name for it, and an empty `main` block in
 * the state file is normal.
 *
 * This is easy to mistake for stale data and delete. Doing so breaks
 * sequential routing and orphans every routing assignment targeting `main`.
 */
export const MAIN_ACCOUNT_ID = "main";

/**
 * Drops only references that genuinely cannot resolve: config accounts with no
 * credentials in the state file.
 *
 * Deliberately leaves `mainAccountId` and an empty `main` block alone, for the
 * reason above.
 */
export function pruneStale(config = configPath()): string[] {
  const storage = loadAccounts(config);
  if (!storage) return [];
  const fixes: string[] = [];

  const hasCreds = (a: Account) => !!(a.access || a.refresh || a.apiKey);
  const before = storage.accounts.length;
  storage.accounts = storage.accounts.filter(hasCreds);
  if (storage.accounts.length !== before) {
    fixes.push(`removed ${before - storage.accounts.length} credential-less account(s)`);
  }

  if (fixes.length) saveAccounts(storage, config);
  return fixes;
}
