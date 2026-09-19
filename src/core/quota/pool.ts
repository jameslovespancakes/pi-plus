export type UsageRow = {
  group: string;
  label: string;
  remaining: number;
  resetAt?: number;
  checkedAt?: number;
  stale?: boolean;
  capacity?: number;
};

/*
 * How old a usage sample may be and still be poolable.
 *
 * This was 6 minutes when every refresh fetched the usage endpoint live.
 * Quota now comes from response headers, backed by a poll at most once per
 * 10 minutes, so a 6 minute bound marked idle accounts stale almost all the
 * time. It must stay comfortably above that poll interval; the underlying
 * windows are 5 hours and 7 days, so a sample minutes old is still accurate.
 */
export const CLAUDE_FRESH_MS = 12 * 60_000;
export const isClaudeAccount = (row: UsageRow) => row.group.startsWith("Claude ") && !row.group.startsWith("Claude pool ×");
export const isFresh = (row: UsageRow, now = Date.now()) => !row.stale && !!row.checkedAt
  && now - row.checkedAt < CLAUDE_FRESH_MS && (!row.resetAt || row.resetAt > now);

/** Percent of combined capacity, not a claim that quota transfers between accounts.
 * Without published capacities this is explicitly an equal-account estimate.
 */
export function combinedWindow(rows: UsageRow[], label: string, expected: number, now = Date.now(), allowPartial = false) {
  const matching = rows.filter((r) => isClaudeAccount(r) && r.label === label && isFresh(r, now));
  const partial = matching.length !== expected;
  if (!expected || !matching.length || (partial && !allowPartial)) return undefined;
  const weighted = matching.every((r) => typeof r.capacity === "number" && r.capacity > 0);
  const total = matching.reduce((sum, r) => sum + (weighted ? r.capacity! : 1), 0);
  const remaining = matching.reduce((sum, r) => sum + r.remaining * (weighted ? r.capacity! : 1), 0) / total;
  const resets = matching.map((r) => r.resetAt).filter((t): t is number => !!t && t > now);
  return { label, remaining, resetAt: resets.length ? Math.min(...resets) : undefined, estimated: !weighted, partial };
}

export function scopedLabels(rows: UsageRow[], modelId?: string): string[] {
  const labels = [...new Set(rows.filter(isClaudeAccount).map((r) => r.label).filter((l) => l.startsWith("7d ")))];
  const model = modelId?.toLowerCase() ?? "";
  return labels.sort((a, b) => Number(matchesScope(b, model)) - Number(matchesScope(a, model)) || a.localeCompare(b));
}

function matchesScope(label: string, model: string): boolean {
  const family = label.slice(3).toLowerCase();
  return model.includes(family) || (family === "fable" && model.includes("mythos"));
}

/** An account must pass ALL applicable windows; independent averages cannot answer this. */
export function poolAvailability(rows: UsageRow[], expected: number, modelId?: string, now = Date.now()) {
  const groups = [...new Set(rows.filter(isClaudeAccount).map((r) => r.group))];
  let ready = 0;
  let unknown = Math.max(0, expected - groups.length);
  for (const group of groups) {
    const account = rows.filter((r) => r.group === group);
    const required = ["5h", "7d", ...scopedLabels(account).filter((l) => matchesScope(l, modelId?.toLowerCase() ?? ""))];
    const windows = required.map((label) => account.find((r) => r.label === label));
    if (windows.some((r) => r && isFresh(r, now) && r.remaining <= 0)) continue;
    if (windows.some((r) => !r || !isFresh(r, now))) { unknown++; continue; }
    ready++;
  }
  return { ready, unknown, total: expected };
}
