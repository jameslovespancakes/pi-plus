import { loadAccounts, saveAccount, type Account, type QuotaSnapshot } from "./store.ts";
import { refreshToken } from "./oauth.ts";

/**
 * Quota tracking.
 *
 * There are two sources, and the cheap one is strongly preferred:
 *
 *   1. Response headers. Every `/v1/messages` reply carries the same numbers
 *      as the usage endpoint, so the account actually serving traffic keeps
 *      its snapshot current at no request cost at all.
 *   2. The usage endpoint. Only needed for accounts that are NOT serving
 *      traffic, since routing compares accounts and an idle one would
 *      otherwise never update.
 *
 * Polling used to run on a 5 minute timer regardless of activity. That is what
 * the backoff below exists for: the endpoint rate limits, it answers 429 with
 * `retry-after: 0`, and `pollQuota` reports failure as `undefined`, so the
 * throttling was invisible and simply left routing on stale data.
 */

const QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 10_000;
/**
 * Selection tolerates a snapshot this old before it is worth re-polling.
 *
 * This doubles as the poll rate limiter. Polling is triggered by sending a
 * message, so this is the floor between polls however fast you type: send a
 * message after the window and it polls, send ten inside it and it polls once.
 */
export const QUOTA_FRESH_MS = 10 * 60_000;
/** After a 429, wait at least this long before touching the endpoint again. */
export const QUOTA_BACKOFF_MS = 15 * 60_000;

/** Per-account earliest next poll, set when the endpoint rate limits us. */
const blockedUntil = new Map<string, number>();

/** True when a recent 429 means this account must not be polled yet. */
export function isPollBlocked(accountId: string, now = Date.now()): boolean {
  const until = blockedUntil.get(accountId);
  if (until === undefined) return false;
  if (now >= until) { blockedUntil.delete(accountId); return false; }
  return true;
}

/** Visible for tests; clears the backoff table. */
export function resetPollBackoff(): void {
  blockedUntil.clear();
}

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

/**
 * Reads a quota snapshot out of `/v1/messages` response headers.
 *
 * Anthropic reports utilisation here as a FRACTION (`0.16`), while the usage
 * endpoint reports a PERCENT (`16`). Verified against the same account at the
 * same moment, including matching reset timestamps. Scaling by 100 is what
 * makes the two sources comparable, so do not drop it.
 *
 * Returns undefined when the headers are absent, which is normal: they do not
 * appear on 4xx replies, and non-Anthropic transports may not expose them.
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
    if (raw === undefined) return undefined;
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

/**
 * Merges a header-derived snapshot into an account.
 *
 * Scoped per-model limits only come from the usage endpoint, so they are
 * carried over from the previous snapshot rather than dropped.
 */
export function applyQuotaHeaders(
  accountId: string,
  headers: Record<string, unknown> | undefined,
  now = Date.now(),
): boolean {
  const fresh = parseQuotaHeaders(headers, now);
  if (!fresh) return false;

  const storage = loadAccounts();
  const account = storage?.accounts.find((a) => a.id === accountId);
  if (!account) return false;

  // Headers arrive on every response, but utilisation moves in whole percent
  // steps over windows of hours. Rewriting two credential files per request to
  // store an unchanged number is pure write amplification, and on Windows each
  // rewrite is another chance for the rename to collide with a file lock.
  const previous = account.quota;
  const unchanged =
    previous?.five_hour?.usedPercent === fresh.five_hour?.usedPercent
    && previous?.seven_day?.usedPercent === fresh.seven_day?.usedPercent;
  if (unchanged) return false;

  saveAccount({ ...account, quota: { ...fresh, scoped: previous?.scoped } });
  return true;
}

/**
 * Polls one account. Returns undefined rather than throwing on failure.
 *
 * Pass `accountId` so a 429 registers backoff; without it the caller can
 * hammer a throttled endpoint and silently keep stale quota.
 */
export async function pollQuota(
  accessToken: string,
  accountId?: string,
): Promise<QuotaSnapshot | undefined> {
  if (accountId && isPollBlocked(accountId)) return undefined;
  try {
    const response = await fetch(QUOTA_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429 && accountId) {
      // `retry-after` is commonly 0 here, which is not a usable hint, so the
      // floor is ours rather than the server's.
      const hint = Number(response.headers.get("retry-after")) * 1000;
      const wait = Number.isFinite(hint) && hint > 0 ? hint : QUOTA_BACKOFF_MS;
      blockedUntil.set(accountId, Date.now() + Math.max(wait, QUOTA_BACKOFF_MS));
      return undefined;
    }
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
    (a) => a.enabled !== false && a.type === "oauth"
      && (force || !isFresh(a.quota, now))
      && !isPollBlocked(a.id, now));

  const results = await Promise.all(stale.map(async (account) => {
    try {
      const token = await ensureAccessToken(account);
      if (!token) return false;
      const quota = await pollQuota(token, account.id);
      if (!quota) return false;
      saveAccount({ ...account, quota });
      return true;
    } catch {
      return false;
    }
  }));

  return results.filter(Boolean).length;
}
