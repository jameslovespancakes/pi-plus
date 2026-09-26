import { createHash } from "node:crypto";
import { acquireFileLease } from "../file-lease.ts";
import { refreshAbortSignal } from "../accounts/routing.ts";
import {
  configPath as defaultConfigPath,
  loadAccounts,
  saveAccount,
  statePath,
  type Account,
  type QuotaSnapshot,
} from "./store.ts";
import { refreshToken, type RefreshOptions, type TokenSet } from "./oauth.ts";

/** Quota parsing and pooled credential refresh. Status I/O lives in usage-cache.ts. */
/** Refresh early enough to absorb transient OAuth rate limits before expiry. */
export const ACCESS_REFRESH_WINDOW_MS = 4 * 60 * 60_000;
/** Background refresh cadence; each process adds a small startup jitter. */
export const ACCESS_REFRESH_INTERVAL_MS = 5 * 60_000;
const REFRESH_LOCK_TTL_MS = 60_000;
const REFRESH_JOIN_WAIT_MS = 16_000;
/** Snapshot lifetime and minimum interval between polls. */
export const QUOTA_FRESH_MS = 10 * 60_000;
const pct = (value: unknown): number | undefined => {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
};

/** Normalises Anthropic's payload into the snapshot shape the store holds. */
export function parseQuota(body: any, now = Date.now()): QuotaSnapshot {
  const window = (raw: any) => {
    const used = pct(raw?.utilization);
    if (used === undefined) return undefined;
    return {
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: typeof raw?.resets_at === "string" ? raw.resets_at : undefined,
      checkedAt: now,
      capacity: typeof raw?.limit_dollars === "number" && raw.limit_dollars > 0 ? raw.limit_dollars : undefined,
    };
  };

  // `limits` also restates the session and weekly windows (`kind: session`,
  // `weekly_all`) with no scope. Only model-scoped entries are extra limits;
  // keeping the others filed the 5h and 7d windows a second time as "scoped".
  const scoped = (Array.isArray(body?.limits) ? body.limits : [])
    .map((limit: any) => {
      const name = limit?.scope?.model?.display_name;
      const used = pct(limit?.percent);
      if (typeof name !== "string" || !name || used === undefined) return undefined;
      return {
        id: name.toLowerCase(),
        usedPercent: used,
        remainingPercent: 100 - used,
        resetsAt: typeof limit?.resets_at === "string" ? limit.resets_at : undefined,
        checkedAt: now,
      };
    })
    .filter(Boolean);

  for (const [id, raw] of [["opus", body?.seven_day_opus ?? body?.seven_day_omelette], ["sonnet", body?.seven_day_sonnet]] as const) {
    const value = window(raw);
    if (value && !scoped.some((entry: { id: string }) => entry.id === id)) scoped.push({ id, ...value });
  }

  return {
    five_hour: window(body?.five_hour),
    seven_day: window(body?.seven_day),
    extra: body?.extra_usage?.is_enabled ? window(body.extra_usage) : undefined,
    scoped: scoped.length ? scoped : undefined,
    checkedAt: now,
    source: "poll",
  };
}

export function isFresh(quota: QuotaSnapshot | undefined, now = Date.now()): boolean {
  const at = quota?.checkedAt ?? 0;
  return at > 0 && now - at < QUOTA_FRESH_MS;
}

/**
 * Parses response quota headers. Header utilization is a fraction, while the
 * usage endpoint returns a percentage, so header values are scaled by 100.
 */
export function parseQuotaHeaders(
  headers: Record<string, unknown> | undefined,
  now = Date.now(),
): QuotaSnapshot | undefined {
  if (!headers) return undefined;

  // Header casing is not guaranteed across transports.
  const get = (name: string): string | undefined => {
    const key = `anthropic-ratelimit-unified-${name}`;
    const direct = headers[key] ?? headers[key.toUpperCase()];
    if (direct !== undefined && direct !== null) return String(direct);
    const found = Object.keys(headers).find((k) => k.toLowerCase() === key);
    return found === undefined ? undefined : String(headers[found]);
  };

  const window = (prefix: string) => {
    const raw = get(`${prefix}-utilization`);
    if (raw === undefined || !raw.trim()) return undefined;
    const fraction = Number(raw);
    if (!Number.isFinite(fraction)) return undefined;

    const used = Math.min(100, Math.max(0, fraction * 100));
    const resetSeconds = Number(get(`${prefix}-reset`));
    return {
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: Number.isFinite(resetSeconds) && resetSeconds > 0
        ? new Date(resetSeconds * 1000).toISOString()
        : undefined,
      checkedAt: now,
    };
  };

  const five_hour = window("5h");
  const seven_day = window("7d");
  if (!five_hour && !seven_day) return undefined;

  return { five_hour, seven_day, checkedAt: now, source: "headers" };
}

export function accessTokenNeedsRefresh(account: Account, now = Date.now()): boolean {
  return !account.access
    || typeof account.expires !== "number"
    || account.expires - now <= ACCESS_REFRESH_WINDOW_MS;
}

type RefreshTokenFn = (options: RefreshOptions) => Promise<TokenSet>;

export interface EnsureAccessTokenOptions {
  config?: string;
  now?: () => number;
  refresh?: RefreshTokenFn;
}

const refreshes = new Map<string, Promise<string | undefined>>();

function refreshLockPath(accountId: string, config: string): string {
  const id = createHash("sha256").update(accountId).digest("hex").slice(0, 16);
  return `${statePath(config)}.refresh-${id}.lock`;
}

function storedAccount(accountId: string, config: string): Account | undefined {
  return loadAccounts(config)?.accounts.find((candidate) => candidate.id === accountId);
}

function usableAccess(account: Account | undefined, now: number): string | undefined {
  return account?.access && typeof account.expires === "number" && account.expires > now
    ? account.access
    : undefined;
}

async function joinConcurrentRefresh(
  account: Account,
  config: string,
  now: () => number,
): Promise<string | undefined> {
  const deadline = now() + REFRESH_JOIN_WAIT_MS;
  while (now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const latest = storedAccount(account.id, config);
    const changed = latest && (
      latest.access !== account.access
      || latest.refresh !== account.refresh
      || (latest.expires ?? 0) > (account.expires ?? 0) + 60_000
    );
    if (changed && !accessTokenNeedsRefresh(latest, now())) return latest.access;
  }
  return usableAccess(storedAccount(account.id, config) ?? account, now());
}

function refreshErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

async function refreshAccountNow(
  account: Account,
  options: EnsureAccessTokenOptions,
): Promise<string | undefined> {
  const config = options.config ?? defaultConfigPath();
  const now = options.now ?? Date.now;
  const refresh = options.refresh ?? refreshToken;
  let latest = storedAccount(account.id, config) ?? account;
  if (!accessTokenNeedsRefresh(latest, now())) return latest.access;
  if (!latest.refresh) return usableAccess(latest, now());

  const lock = acquireFileLease(refreshLockPath(account.id, config), REFRESH_LOCK_TTL_MS, now());
  if (!lock) return joinConcurrentRefresh(latest, config, now);

  try {
    // The lock winner re-reads so it never spends a refresh token rotated by a
    // different process immediately before the lock was acquired.
    latest = storedAccount(account.id, config) ?? latest;
    if (!accessTokenNeedsRefresh(latest, now())) return latest.access;
    if (!latest.refresh) return usableAccess(latest, now());

    const sourceRefresh = latest.refresh;
    try {
      const refreshed = await refresh({
        refreshToken: sourceRefresh,
        signal: refreshAbortSignal(),
      });
      const current = storedAccount(account.id, config) ?? latest;
      // A changed refresh token is a stronger, newer write. Never overwrite it
      // with the result of an older token family.
      if (current.refresh !== sourceRefresh) return usableAccess(current, now());
      saveAccount({
        ...current,
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        lastRefreshedAt: now(),
        lastRefreshError: undefined,
      }, config);
      return refreshed.access;
    } catch (error) {
      const current = storedAccount(account.id, config) ?? latest;
      if (current.refresh === sourceRefresh) {
        saveAccount({ ...current, lastRefreshError: refreshErrorMessage(error) }, config);
      }
      throw error;
    }
  } finally {
    lock.release();
  }
}

/** Returns a usable token, proactively rotating it well before expiry. */
export async function ensureAccessToken(
  account: Account,
  options: EnsureAccessTokenOptions = {},
): Promise<string | undefined> {
  const config = options.config ?? defaultConfigPath();
  const now = options.now ?? Date.now;
  if (!accessTokenNeedsRefresh(account, now())) return account.access;
  if (!account.refresh) return usableAccess(account, now());

  const key = `${config}\0${account.id}`;
  const active = refreshes.get(key);
  if (active) return active;
  const pending = refreshAccountNow(account, options).finally(() => refreshes.delete(key));
  refreshes.set(key, pending);
  return pending;
}

/** Rotates every due sidecar token independently of quota freshness. */
export async function refreshDueAccessTokens(
  config = defaultConfigPath(),
  options: EnsureAccessTokenOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const accounts = (loadAccounts(config)?.accounts ?? []).filter(
    (account) => account.enabled !== false && account.type === "oauth" && accessTokenNeedsRefresh(account, now()),
  );
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      return Boolean(await ensureAccessToken(account, { ...options, config }));
    } catch {
      return false;
    }
  }));
  return results.filter(Boolean).length;
}
