import { createHash } from "node:crypto";
import { acquireFileLease } from "../file-lease.ts";
import { readJson, writeJson } from "../store.ts";
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
const readCache = (paths: string[]): UsageCache => paths.map((path) => readJson<UsageCache>(path, {}))
  .sort((a, b) => (b.nextPollAt ?? 0) - (a.nextPollAt ?? 0))[0] ?? {};
const saveCache = (paths: string[], cache: UsageCache): boolean => paths.every((path) => writeJson(path, cache, false, 0o600));

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

/** Free telemetry from the actual request credential; never use a global last-routed account. */
export function observeClaudeQuota(access: string, headers: Record<string, unknown>, now = Date.now()): void {
  const fresh = parseQuotaHeaders(headers, now);
  if (!fresh) return;
  const account = loadAccounts()?.accounts.find((candidate) => candidate.access === access);
  const target = { access, id: account?.id, identity: account?.identity ?? cachedAnthropicAccountIdentity(access), quota: account?.quota };
  const paths = cachePaths(target);
  const release = lockCache(paths, now);
  if (!release) return; // An in-flight status fetch will refresh this account instead.
  try {
    saveCache(paths, { ...readCache(paths), quota: mergeQuota(cachedClaudeQuota(target), fresh) });
  } finally { release(); }
}

function hasFreshWindows(quota: QuotaSnapshot | undefined, now: number): boolean {
  return [quota?.five_hour, quota?.seven_day].every((window) =>
    window && isFresh({ checkedAt: window.checkedAt ?? quota?.checkedAt }, now));
}

/** The only Claude status fetch path. Manual refresh and process restarts cannot bypass its cooldown. */
export async function readClaudeQuota(account: ClaudeUsageAccount, now = Date.now()): Promise<{ quota?: QuotaSnapshot; error?: string }> {
  const paths = cachePaths(account);
  const cached = () => cachedClaudeQuota(account);
  const initial = cached();
  if (hasFreshWindows(initial, now)) return { quota: initial };
  const release = lockCache(paths, now);
  if (!release) return { quota: cached() };
  try {
    const current = readCache(paths);
    const quota = cached();
    if (hasFreshWindows(quota, now)) return { quota };
    if ((current.nextPollAt ?? 0) > now) return { quota, error: current.error };

    // Reserve before I/O: even a crash or failed final write must not trigger a retry storm.
    if (!saveCache(paths, { ...current, quota, nextPollAt: now + QUOTA_BACKOFF_MS })) {
      return { quota, error: "Could not persist usage cooldown" };
    }
    let error: string;
    let retryAfter = 0;
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${account.access}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const fresh = parseQuota(await response.json(), now);
        if (fresh.five_hour || fresh.seven_day) {
          saveCache(paths, { quota: fresh, nextPollAt: now + QUOTA_FRESH_MS, failures: 0 });
          return { quota: fresh };
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
    saveCache(paths, { quota, failures, error, nextPollAt: now + wait });
    return { quota, error };
  } finally { release(); }
}
