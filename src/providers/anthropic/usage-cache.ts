import { createHash } from "node:crypto";
import { acquireFileLease } from "../../core/file-lease.ts";
import { accountRetryAt } from "../shared/accounts/provider-errors.ts";
import { readJson, writeJson } from "../../core/store.ts";
import { cachedAnthropicAccountIdentity } from "./identity.ts";
import { isFresh, parseQuota, parseQuotaHeaders, QUOTA_FRESH_MS } from "./quota.ts";
import { loadAccounts, statePath, type QuotaSnapshot } from "./store.ts";

export const QUOTA_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 2 * 60 * 60_000;
const LEASE_MS = 60_000;

export interface ClaudeUsageAccount {
  access: string;
  identity?: string;
  id?: string;
  /** Read old snapshots without maintaining a second quota store. */
  quota?: QuotaSnapshot;
}
interface UsageCache {
  quota?: QuotaSnapshot;
  nextPollAt?: number;
  failures?: number;
  error?: string;
  cooldowns?: Record<string, number>;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function cachePath(account: ClaudeUsageAccount): string {
  const key = account.identity ? `identity:${account.identity}` : account.id ? `account:${account.id}` : `token:${account.access}`;
  return `${statePath()}.usage-${hash(key)}.json`;
}

function cachePaths(account: ClaudeUsageAccount): string[] {
  // The token alias preserves cooldown when identity discovery is temporarily unavailable.
  return [...new Set([cachePath(account), cachePath({ access: account.access })])];
}
function lockCache(paths: string[], now: number): (() => void) | undefined {
  const leases: Array<{ release(): void }> = [];
  const release = () => leases.forEach((lease) => lease.release());
  try {
    for (const path of paths) {
      const lease = acquireFileLease(`${path}.lock`, LEASE_MS, now);
      if (!lease) { release(); return undefined; }
      leases.push(lease);
    }
    return release;
  } catch (error) { release(); throw error; }
}
const readCache = (paths: string[]): UsageCache => {
  const caches = paths.map((path) => readJson<UsageCache>(path, {}));
  const cooldowns: Record<string, number> = {};
  for (const cache of caches) for (const [model, until] of Object.entries(cache.cooldowns ?? {})) {
    if (Number.isFinite(until)) cooldowns[model] = Math.max(cooldowns[model] ?? 0, until);
  }
  return { ...caches.sort((a, b) => (b.nextPollAt ?? 0) - (a.nextPollAt ?? 0))[0], cooldowns };
};
const saveCache = (paths: string[], cache: UsageCache): boolean => paths.every((path) => writeJson(path, cache, false, 0o600));
function updateCache(paths: string[], now: number, update: (cache: UsageCache) => UsageCache): boolean {
  const release = lockCache(paths, now);
  if (!release) return false;
  try { return saveCache(paths, update(readCache(paths))); }
  finally { release(); }
}

/** Preserve missing windows and each window's own observation time. */
function mergeQuota(previous: QuotaSnapshot | undefined, next: QuotaSnapshot): QuotaSnapshot {
  const merged = { ...previous, ...next };
  for (const key of ["five_hour", "seven_day"] as const) {
    const old = previous?.[key], fresh = next[key];
    const observedAt = fresh?.checkedAt ?? next.checkedAt ?? 0;
    merged[key] = fresh && observedAt >= (old?.checkedAt ?? 0) ? {
      ...old, ...fresh,
      resetsAt: fresh.resetsAt ?? (Date.parse(old?.resetsAt ?? "") > observedAt ? old?.resetsAt : undefined),
    } : old;
  }
  merged.scoped = next.scoped ?? previous?.scoped;
  merged.extra = next.extra ?? previous?.extra;
  return merged;
}

/** Shared disk cache, with token-keyed observations as a fallback before identity discovery. */
export function cachedClaudeQuota(account: ClaudeUsageAccount): QuotaSnapshot | undefined {
  const samples = [account.quota, ...cachePaths(account).map((path) => readJson<UsageCache>(path, {}).quota)]
    .filter((quota): quota is QuotaSnapshot => !!quota)
    .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0));
  return samples.reduce<QuotaSnapshot | undefined>((merged, sample) => mergeQuota(merged, sample), undefined);
}

export function cachedClaudeCooldown(account: ClaudeUsageAccount, modelId?: string): number | undefined {
  const blocks = readCache(cachePaths(account)).cooldowns;
  const until = Math.max(blocks?.["*"] ?? 0, modelId ? blocks?.[modelId] ?? 0 : 0);
  return until > Date.now() ? until : undefined;
}

/** Per-attempt observations use the credential actually sent, including headerless failures. */
export function observeClaudeQuota(access: string, headers: Record<string, unknown>, now = Date.now(),
  observation: { status?: number; modelId?: string; blockedUntil?: number } = {},
): void {
  const fresh = parseQuotaHeaders(headers, now);
  if (!fresh && observation.status !== 429 && observation.blockedUntil === undefined) return;
  const account = loadAccounts()?.accounts.find((candidate) => candidate.access === access);
  const target = { access, id: account?.id, identity: account?.identity ?? cachedAnthropicAccountIdentity(access), quota: account?.quota };
  const paths = cachePaths(target);
  updateCache(paths, now, (cache) => {
    if (observation.status === 429 || observation.blockedUntil !== undefined) {
      const key = observation.modelId ?? "*";
      cache.cooldowns = { ...cache.cooldowns, [key]: Math.max(cache.cooldowns?.[key] ?? 0,
        observation.blockedUntil ?? accountRetryAt(headers as Record<string, string>, "", now)) };
    }
    return { ...cache, quota: fresh ? mergeQuota(cachedClaudeQuota(target), fresh) : cachedClaudeQuota(target) };
  });
}

function hasFreshWindows(quota: QuotaSnapshot | undefined, now: number): boolean {
  return [quota?.five_hour, quota?.seven_day].every((window) =>
    window && isFresh({ checkedAt: window.checkedAt ?? quota?.checkedAt }, now));
}

/** The only Claude status fetch path. Manual refresh and process restarts cannot bypass its cooldown. */
export async function readClaudeQuota(account: ClaudeUsageAccount, now = Date.now(), signal?: AbortSignal): Promise<{ quota?: QuotaSnapshot; error?: string }> {
  const paths = cachePaths(account);
  const cached = () => cachedClaudeQuota(account);
  const initial = cached();
  if (hasFreshWindows(initial, now)) return { quota: initial };
  // Hold only a polling lease across HTTP. Response observations must not be
  // dropped merely because a usage request is still in flight.
  const release = lockCache(paths.map((path) => `${path}.poll`), now);
  if (!release) return { quota: cached() };
  try {
    const current = readCache(paths);
    const quota = cached();
    if (hasFreshWindows(quota, now)) return { quota };
    if ((current.nextPollAt ?? 0) > now) return { quota, error: current.error };

    // Reserve before I/O: even a crash or failed final write must not trigger a retry storm.
    if (!updateCache(paths, now, (cache) => ({ ...cache, quota, nextPollAt: now + QUOTA_BACKOFF_MS }))) {
      return { quota, error: "Could not persist usage cooldown" };
    }
    let error: string;
    let retryAfter = 0;
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${account.access}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const fresh = parseQuota(await response.json(), now);
        if (fresh.five_hour || fresh.seven_day) {
          const merged = mergeQuota(cached(), fresh);
          updateCache(paths, now, (cache) => ({ ...cache, quota: merged, nextPollAt: now + QUOTA_FRESH_MS, failures: 0, error: undefined }));
          return { quota: merged };
        }
        error = "Usage windows unavailable";
      } else {
        error = `HTTP ${response.status}`;
        const hint = response.headers.get("retry-after");
        if (hint) retryAfter = /^\s*\d+(\.\d+)?\s*$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - now;
      }
    } catch {
      error = "Usage request failed"; // Never echo tokens or raw provider bodies.
    }
    const failures = Math.min((current.failures ?? 0) + 1, 8);
    const backoff = Math.min(MAX_BACKOFF_MS, QUOTA_BACKOFF_MS * 2 ** (failures - 1));
    const wait = Math.max(backoff, Number.isFinite(retryAfter) ? retryAfter : 0);
    const latestQuota = cached();
    updateCache(paths, now, (cache) => ({ ...cache, quota: latestQuota, failures, error, nextPollAt: now + wait }));
    return { quota: latestQuota, error };
  } finally { release(); }
}
