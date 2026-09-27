import { ACCOUNT_RETRY_COOLDOWN_MS } from "./provider-errors.ts";

export interface AccountQuotaState {
  remainingPercent?: number;
  resetAt?: number;
  checkedAt: number;
  blockedUntil?: number;
}

export interface AccountRoutingCandidate<T> {
  readonly id: string;
  readonly order: number;
  readonly lastUsed: number;
  readonly quota?: AccountQuotaState;
  readonly value: T;
}

export type AccountRoutingMode = "sequential" | "quota-aware";

/**
 * Upper bound on a token refresh, matching pi-ai's own
 * `DEFAULT_OAUTH_REFRESH_TIMEOUT_MS` in `auth/resolve.js`.
 *
 * Routed auth runs outside pi-ai's refresh path, so nothing else bounds it.
 * An unbounded refresh against a stalled token endpoint hangs the request
 * forever, and because in-flight refreshes are de-duplicated per account,
 * every later request joins the same hung promise.
 */
export const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/** Bounds a refresh, honouring a caller signal when one is available. */
export function refreshAbortSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Maps stored legacy names onto the two routing modes. */
export function normalizeRoutingMode(value: string | undefined): AccountRoutingMode {
  return value === "quota-aware" || value === "optimal" || value === "sticky-balanced"
    ? "quota-aware"
    : "sequential";
}

/** Sequential keeps account order; quota-aware prefers unmeasured then highest remaining capacity. */
export function selectRoutingCandidate<T>(
  candidates: readonly AccountRoutingCandidate<T>[],
  mode: AccountRoutingMode,
  now = Date.now(),
): AccountRoutingCandidate<T> | undefined {
  if (candidates.length === 0) return undefined;
  const viable = candidates.filter((candidate) => isCandidateViable(candidate.quota, now));
  if (viable.length === 0) return undefined;

  if (mode === "sequential") {
    return [...viable].sort((left, right) => left.order - right.order)[0];
  }

  const unmeasured = viable.filter((candidate) => candidate.quota?.remainingPercent === undefined);
  if (unmeasured.length > 0) return leastRecentlyUsed(unmeasured);

  return [...viable].sort((left, right) =>
    (right.quota?.remainingPercent ?? 0) - (left.quota?.remainingPercent ?? 0)
    || left.lastUsed - right.lastUsed
    || left.order - right.order
    || left.id.localeCompare(right.id))[0];
}

export function quotaStateFromHeaders(
  status: number,
  headers: Record<string, string>,
  previous?: AccountQuotaState,
  now = Date.now(),
): AccountQuotaState | undefined {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const remaining = firstNumber(normalized, [
    "x-ratelimit-remaining-requests",
    "ratelimit-remaining-requests",
    "x-ratelimit-remaining",
    "ratelimit-remaining",
  ]);
  const limit = firstNumber(normalized, [
    "x-ratelimit-limit-requests",
    "ratelimit-limit-requests",
    "x-ratelimit-limit",
    "ratelimit-limit",
  ]);
  const resetAt = parseResetAt(normalized, now);

  if (status === 429) {
    // A transient block must not erase a known longer (or unknown) quota exhaustion.
    if (previous?.remainingPercent === 0 && previous.resetAt === undefined && previous.blockedUntil === undefined) {
      return { ...previous, checkedAt: now };
    }
    const knownReset = previous?.remainingPercent === 0 && (previous.resetAt ?? 0) > now ? previous.resetAt : undefined;
    const effectiveReset = Math.max(resetAt ?? 0, knownReset ?? 0) || undefined;
    return {
      remainingPercent: 0,
      resetAt: effectiveReset,
      checkedAt: now,
      blockedUntil: Math.max(previous?.blockedUntil ?? 0, effectiveReset ?? now + ACCOUNT_RETRY_COOLDOWN_MS),
    };
  }
  if (remaining === undefined) return previous;

  const remainingPercent = limit && limit > 0
    ? Math.max(0, Math.min(100, remaining / limit * 100))
    : Math.max(0, Math.min(100, remaining));
  return { remainingPercent, resetAt, checkedAt: now,
    ...((previous?.blockedUntil ?? 0) > now && { blockedUntil: previous!.blockedUntil }),
  };
}

/**
 * Exhausted-with-no-reset is already handled by `isCandidateViable` below, so
 * callers never need a sentinel `blockedUntil`. Persisting `Infinity` would
 * serialize to `null` and silently unblock on the next load.
 */
function isCandidateViable(quota: AccountQuotaState | undefined, now: number): boolean {
  if (!quota) return true;
  if (quota.blockedUntil !== undefined) {
    if (quota.blockedUntil > now) return false;
    // A temporary 429 without a quota reset is not permanent exhaustion.
    if (quota.resetAt === undefined) return true;
  }
  if (quota.remainingPercent !== 0) return true;
  return quota.resetAt !== undefined && quota.resetAt <= now;
}

/** Ignore elapsed windows; all still-exhausted windows must reset before reuse. */
export function quotaStateFromWindows(
  windows: readonly { remainingPercent?: number; resetAt?: number }[], checkedAt: number, now = Date.now(),
): AccountQuotaState | undefined {
  const current = windows.filter((window) => Number.isFinite(window.remainingPercent)
    && !(window.resetAt !== undefined && window.resetAt <= now));
  if (current.length === 0) return undefined;
  const remainingPercent = Math.min(...current.map((window) => window.remainingPercent!));
  const empty = current.filter((window) => window.remainingPercent! <= 0);
  const knownResets = empty.map((window) => window.resetAt).filter((at): at is number => at !== undefined && Number.isFinite(at));
  const resetAt = empty.length > 0 && knownResets.length === empty.length ? Math.max(...knownResets) : undefined;
  return { remainingPercent, resetAt, checkedAt, ...(remainingPercent <= 0 && resetAt !== undefined && { blockedUntil: resetAt }) };
}

function leastRecentlyUsed<T>(candidates: readonly AccountRoutingCandidate<T>[]): AccountRoutingCandidate<T> {
  return [...candidates].sort((left, right) =>
    left.lastUsed - right.lastUsed
    || left.order - right.order
    || left.id.localeCompare(right.id))[0];
}

function firstNumber(headers: ReadonlyMap<string, string>, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = Number(headers.get(name));
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseResetAt(headers: ReadonlyMap<string, string>, now: number): number | undefined {
  const retryRaw = headers.get("retry-after");
  const retryAfter = retryRaw?.trim() ? Number(retryRaw) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return now + retryAfter * 1_000;
  const retryDate = Date.parse(retryRaw ?? "");
  if (Number.isFinite(retryDate)) return retryDate;

  const raw = firstNumber(headers, [
    "x-ratelimit-reset-requests",
    "ratelimit-reset-requests",
    "x-ratelimit-reset",
    "ratelimit-reset",
  ]);
  if (raw === undefined) return undefined;
  if (raw > 1_000_000_000_000) return raw;
  if (raw > 1_000_000_000) return raw * 1_000;
  return now + raw * 1_000;
}
