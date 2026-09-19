import { loadAccounts, saveAccount, type Account, type QuotaSnapshot } from "./store.ts";
import { refreshToken } from "./oauth.ts";

/**
 * Quota polling.
 *
 * Anthropic exposes remaining quota on a dedicated OAuth endpoint. Selection
 * needs this to be current-ish but not live: polling on a timer and selecting
 * from the cached snapshot is enough, and keeps account choice synchronous.
 */

const QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 10_000;
/** Selection tolerates a snapshot this old before it is worth re-polling. */
export const QUOTA_FRESH_MS = 5 * 60_000;

const pct = (value: unknown): number | undefined => {
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
    };
  };

  const scoped = (Array.isArray(body?.limits) ? body.limits : [])
    .map((limit: any) => {
      const used = pct(limit?.percent);
      if (used === undefined) return undefined;
      return {
        id: String(limit?.scope?.model?.display_name ?? limit?.id ?? "scoped").toLowerCase(),
        usedPercent: used,
        remainingPercent: 100 - used,
        resetsAt: typeof limit?.resets_at === "string" ? limit.resets_at : undefined,
        checkedAt: now,
      };
    })
    .filter(Boolean);

  return {
    five_hour: window(body?.five_hour),
    seven_day: window(body?.seven_day),
    scoped: scoped.length ? scoped : undefined,
    checkedAt: now,
    source: "poll",
  };
}

export function isFresh(quota: QuotaSnapshot | undefined, now = Date.now()): boolean {
  const at = quota?.checkedAt ?? 0;
  return at > 0 && now - at < QUOTA_FRESH_MS;
}

/** Polls one account. Returns undefined rather than throwing on failure. */
export async function pollQuota(accessToken: string): Promise<QuotaSnapshot | undefined> {
  try {
    const response = await fetch(QUOTA_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseQuota(await response.json());
  } catch {
    return undefined;
  }
}

/** A token good for at least a minute, refreshing and persisting if needed. */
export async function ensureAccessToken(account: Account): Promise<string | undefined> {
  if (account.access && typeof account.expires === "number" && Date.now() + 60_000 < account.expires) {
    return account.access;
  }
  if (!account.refresh) return account.access;

  const refreshed = await refreshToken({ refreshToken: account.refresh, maxRetries: 0 });
  // Persist immediately: Anthropic may rotate the refresh token, and losing the
  // new one would invalidate the account.
  saveAccount({
    ...account,
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    lastRefreshedAt: Date.now(),
  });
  return refreshed.access;
}

/**
 * Refreshes stale quota for every usable account, in parallel.
 * Best-effort: a failure leaves the previous snapshot in place.
 */
export async function refreshAllQuota(force = false): Promise<number> {
  const storage = loadAccounts();
  if (!storage) return 0;
  const now = Date.now();

  const stale = storage.accounts.filter(
    (a) => a.enabled !== false && a.type === "oauth" && (force || !isFresh(a.quota, now)));

  const results = await Promise.all(stale.map(async (account) => {
    try {
      const token = await ensureAccessToken(account);
      if (!token) return false;
      const quota = await pollQuota(token);
      if (!quota) return false;
      saveAccount({ ...account, quota });
      return true;
    } catch {
      return false;
    }
  }));

  return results.filter(Boolean).length;
}
