import { agentPath, readJson, writeJson } from "../core/store.ts";
import { isClaudeAccount, isGeminiAccount, type UsageRow } from "../core/quota/pool.ts";
import { fetchAll, type SourceOptions } from "../core/quota/usage-source.ts";

/** Shared subscription-usage cache and poller. */

export const REFRESH_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 90_000;
const BACKOFF_MS = 10 * 60 * 1000;
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export interface UsageState {
  rows: UsageRow[];
  errors: string[];
  updatedAt?: number;
  loading: boolean;
  /** Claude accounts expected to report. */
  accounts: number;
  /** Gemini accounts expected to report. */
  geminiAccounts?: number;
  codexPlan?: string;
  /** Last observed quota drop for each account group. */
  lastUsedAt?: Record<string, number>;
}

const state: UsageState = { rows: [], errors: [], loading: true, accounts: 0, geminiAccounts: 0, lastUsedAt: {} };
const listeners = new Set<() => void>();
let sourceOptions: SourceOptions = {};

/** Supplies host services the sources need, such as pi's credential reader. */
export function configureUsageSources(options: SourceOptions): void {
  sourceOptions = { ...sourceOptions, ...options };
}

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
  state.geminiAccounts = cached.geminiAccounts ?? 0;
  state.codexPlan = cached.codexPlan;
  state.updatedAt = cached.updatedAt;
  state.lastUsedAt = cached.lastUsedAt ?? {};
  state.loading = false;
}

function saveCache(): void {
  writeJson(cachePath(), {
    rows: state.rows,
    accounts: state.accounts,
    geminiAccounts: state.geminiAccounts,
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

/** Records use when an account's headline quota falls. */
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

/** Returns recently used account groups with stable fallback ordering. */
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

/** Refreshes cached usage without overlapping requests. */
export async function refreshUsage(ctx: any, force = false): Promise<void> {
  if (inFlight) return inFlight;
  const now = Date.now();
  const dueAt = Math.max(nextAllowedFetch, (state.updatedAt ?? 0) + MIN_INTERVAL_MS);
  if (!force && state.updatedAt && now < dueAt) return;

  inFlight = (async () => {
    try {
      const result = await fetchAll(ctx, sourceOptions);
      // Claude owns a persistent per-account cooldown; it must not stall other providers.
      const rateLimited = result.errors.some((error) => !error.startsWith("Claude ") && error.includes("429"));
      recordUsageDrops(result.rows);

      // Per-account merge: accounts that failed this cycle keep their last
      // figures, marked stale. Removed accounts and header-observed readings
      // (which lapse by design) are not kept.
      const freshGroups = new Set(result.rows.map((row) => row.group));
      const expected = new Set([...result.groups, ...result.geminiGroups]);
      const retained = state.rows
        .filter((row) => !row.group.startsWith("Claude pool ×")
          && !freshGroups.has(row.group)
          && (isClaudeAccount(row) || isGeminiAccount(row) ? expected.has(row.group) : row.group === "Codex"))
        .map((row) => ({ ...row, stale: true }));

      state.rows = [...result.rows, ...retained];
      state.accounts = result.groups.length;
      state.geminiAccounts = result.geminiGroups.length;
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

/** Refreshes stale data for UI and headless callers. */
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
