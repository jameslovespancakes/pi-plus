import { agentPath, readJson, writeJson } from "../core/store.ts";
import { isClaudeAccount, type UsageRow } from "../core/quota/pool.ts";
import { fetchAll } from "../core/quota/usage-source.ts";

/**
 * The single owner of subscription usage state.
 *
 * Previously the only poller lived inside the footer extension and was gated on
 * `ctx.hasUI`, so `list_models` silently read empty rows whenever the footer was
 * hidden or the session was headless (including every workflow subagent).
 * Consumers now call `ensureFresh()` for on-demand data and `subscribe()` for
 * push updates; only one poll is ever in flight regardless of consumer count.
 */

export const REFRESH_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 90_000;
const BACKOFF_MS = 10 * 60 * 1000;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export interface UsageState {
  rows: UsageRow[];
  errors: string[];
  updatedAt?: number;
  loading: boolean;
  accounts: number;
  codexPlan?: string;
  /**
   * Last time each account group's quota was observed to drop. This is the only
   * available proxy for "recently used": providers expose remaining quota but
   * never report which account served a request.
   */
  lastUsedAt?: Record<string, number>;
}

const state: UsageState = { rows: [], errors: [], loading: true, accounts: 0, lastUsedAt: {} };
const listeners = new Set<() => void>();

let nextAllowedFetch = 0;
let inFlight: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
let started = false;

function cachePath(): string {
  return agentPath("usage-bar-cache.json");
}

/** Seed from the last session so a restart shows figures before the first fetch. */
function loadCache(): void {
  const cached = readJson<UsageState | undefined>(cachePath(), undefined);
  if (!cached || !Array.isArray(cached.rows) || !cached.updatedAt) return;
  if (Date.now() - cached.updatedAt > CACHE_MAX_AGE_MS) return;
  state.rows = cached.rows.filter((row) => !row.group.startsWith("Claude pool ×"));
  state.accounts = cached.accounts ?? 0;
  state.codexPlan = cached.codexPlan;
  state.updatedAt = cached.updatedAt;
  state.lastUsedAt = cached.lastUsedAt ?? {};
  state.loading = false;
}

function saveCache(): void {
  writeJson(cachePath(), {
    rows: state.rows,
    accounts: state.accounts,
    codexPlan: state.codexPlan,
    updatedAt: state.updatedAt,
    lastUsedAt: state.lastUsedAt,
  });
}

loadCache();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch { /* a bad subscriber must not break the poll */ }
  }
}

/**
 * Stamps an account as recently used when its headline window falls. A rise
 * (quota reset) or an unchanged figure is not a usage signal.
 */
function recordUsageDrops(fresh: UsageRow[]): void {
  const previous = new Map(
    state.rows.filter((row) => row.label === "5h").map((row) => [row.group, row.remaining]),
  );
  const stamps = { ...(state.lastUsedAt ?? {}) };
  for (const row of fresh) {
    if (row.label !== "5h") continue;
    const before = previous.get(row.group);
    if (before !== undefined && row.remaining < before - 0.01) stamps[row.group] = Date.now();
  }
  state.lastUsedAt = stamps;
}

export function usageState(): UsageState {
  return state;
}

/**
 * Account groups ordered by most recent observed use, capped at `limit`.
 * Accounts never seen in use fall back to alphabetical, so the list is stable.
 */
export function recentAccounts(limit: number): string[] {
  const stamps = state.lastUsedAt ?? {};
  const groups = [...new Set(state.rows.filter(isClaudeAccount).map((row) => row.group))];
  return groups
    .sort((a, b) => (stamps[b] ?? 0) - (stamps[a] ?? 0) || a.localeCompare(b))
    .slice(0, limit);
}

/** Notified after every state change. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The endpoints are rate limited, so results are cached and refreshes are
 * throttled. Failures keep the previous figures on screen.
 */
export async function refreshUsage(ctx: any, force = false): Promise<void> {
  if (inFlight) return inFlight;
  const now = Date.now();
  const dueAt = Math.max(nextAllowedFetch, (state.updatedAt ?? 0) + MIN_INTERVAL_MS);
  if (!force && state.updatedAt && now < dueAt) return;

  inFlight = (async () => {
    try {
      const result = await fetchAll(ctx);
      const rateLimited = result.errors.some((error) => error.includes("429"));
      recordUsageDrops(result.rows);

      // Per-account merge: groups that failed this cycle keep their last figures.
      const freshGroups = new Set(result.rows.map((row) => row.group));
      const retained = state.rows
        .filter((row) => !row.group.startsWith("Claude pool ×")
          && !freshGroups.has(row.group)
          && (!isClaudeAccount(row) || result.groups.includes(row.group)))
        .map((row) => ({ ...row, stale: true }));

      state.rows = [...result.rows, ...retained];
      state.accounts = result.groups.length;
      state.updatedAt = Date.now(); // poll time only; rows retain their own checkedAt
      state.errors = result.errors;
      if (result.codexPlan !== undefined) state.codexPlan = result.codexPlan;
      nextAllowedFetch = rateLimited ? Date.now() + BACKOFF_MS : 0;
      saveCache();
    } catch (error) {
      state.errors = [`Usage refresh failed: ${error instanceof Error ? error.message : String(error)}`];
    } finally {
      state.loading = false;
    }
  })().finally(() => {
    inFlight = undefined;
    emit();
  });

  return inFlight;
}

/**
 * Guarantees usable data for a caller that does not own the poll loop.
 * This is what makes `list_models` correct in headless sessions.
 */
export async function ensureFresh(ctx: any): Promise<UsageState> {
  const stale = !state.updatedAt || Date.now() - state.updatedAt > REFRESH_MS;
  if (stale) await refreshUsage(ctx);
  return state;
}

/** Starts the shared interval. Safe to call from multiple domains. */
export function startPolling(ctx: any): void {
  if (started) return;
  started = true;
  void refreshUsage(ctx);
  timer ??= setInterval(() => void refreshUsage(ctx), REFRESH_MS);
  timer.unref?.();
}

export function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  started = false;
}
