import type { QuotaSnapshot } from "../anthropic/store.ts";
import { MAIN_ACCOUNT_ID, loadCodexAccounts, saveCodexAccount, saveCodexAccounts } from "./store.ts";

/**
 * Codex quota, read from response headers.
 *
 * Codex reports usage on every reply through `x-codex-*` headers, so there is
 * no polling path here at all and no equivalent of Anthropic's usage endpoint
 * is needed.
 *
 * Two differences from Anthropic worth remembering:
 *   - percentages are ALREADY 0-100 (`x-codex-primary-used-percent: 2`),
 *     unlike Anthropic's 0-1 fractions, so there is no x100 here;
 *   - the windows are self-describing via `*-window-minutes` rather than being
 *     fixed at 5h/7d, so they are mapped by duration instead of by name.
 */

/** A Codex window lands in the snapshot slot closest to its real duration. */
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

const num = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export function parseCodexQuotaHeaders(
  headers: Record<string, unknown> | undefined,
  now = Date.now(),
): QuotaSnapshot | undefined {
  if (!headers) return undefined;

  const get = (name: string): unknown => {
    const key = `x-codex-${name}`;
    if (headers[key] !== undefined) return headers[key];
    const found = Object.keys(headers).find((k) => k.toLowerCase() === key);
    return found === undefined ? undefined : headers[found];
  };

  const window = (prefix: "primary" | "secondary") => {
    const used = num(get(`${prefix}-used-percent`));
    if (used === undefined) return undefined;
    // A zero-length window is Codex's way of saying "not applicable".
    const minutes = num(get(`${prefix}-window-minutes`));
    if (minutes !== undefined && minutes <= 0) return undefined;

    const clamped = Math.min(100, Math.max(0, used));
    const resetAt = num(get(`${prefix}-reset-at`));
    return {
      usedPercent: clamped,
      remainingPercent: 100 - clamped,
      resetsAt: resetAt !== undefined && resetAt > 0
        ? new Date(resetAt * 1000).toISOString()
        : undefined,
      checkedAt: now,
      windowMinutes: minutes,
    };
  };

  const primary = window("primary");
  const secondary = window("secondary");
  if (!primary && !secondary) return undefined;

  // Map by duration, not by name: the long window is the weekly one.
  const primaryIsLong = (primary?.windowMinutes ?? SEVEN_DAY_MINUTES) >= SEVEN_DAY_MINUTES;

  return {
    seven_day: primaryIsLong ? primary : secondary,
    five_hour: primaryIsLong ? secondary : primary,
    checkedAt: now,
    source: "headers",
    plan: typeof get("plan-type") === "string" ? String(get("plan-type")) : undefined,
  } as QuotaSnapshot;
}

/**
 * True when two snapshots carry the same reading. `checkedAt` moves on every
 * response, so comparing it would defeat the whole check.
 */
function sameQuota(left: QuotaSnapshot | undefined, right: QuotaSnapshot | undefined): boolean {
  if (!left || !right) return false;
  const compare = (snapshot: QuotaSnapshot) => {
    const window = (value: QuotaSnapshot["five_hour"]) =>
      value ? { used: value.usedPercent, resets: value.resetsAt, minutes: (value as any).windowMinutes } : undefined;
    return JSON.stringify({
      five_hour: window(snapshot.five_hour),
      seven_day: window(snapshot.seven_day),
      plan: (snapshot as any).plan,
    });
  };
  return compare(left) === compare(right);
}

/**
 * Merges a header-derived snapshot into the stored account.
 *
 * Runs from `onResponse` on every single reply, so it is deliberately quiet
 * and cheap: unchanged readings never touch the disk, and a failed write is
 * swallowed. Throwing here would reject the awaited `onResponse` inside the
 * provider and kill an in-flight stream — quota telemetry must never do that.
 */
export function applyCodexQuotaHeaders(
  accountId: string,
  headers: Record<string, unknown> | undefined,
  now = Date.now(),
): boolean {
  try {
    const quota = parseCodexQuotaHeaders(headers, now);
    if (!quota) return false;
    const storage = loadCodexAccounts();
    if (accountId === MAIN_ACCOUNT_ID) {
      if (sameQuota(storage.main?.quota, quota)) return false;
      storage.main = { ...storage.main, quota };
      saveCodexAccounts(storage);
      return true;
    }
    const account = storage.accounts.find((candidate) => candidate.id === accountId);
    if (!account) return false;
    if (sameQuota(account.quota, quota)) return false;
    saveCodexAccount({ ...account, quota });
    return true;
  } catch {
    // Best effort: a quota write must never break the request that produced it.
    return false;
  }
}
