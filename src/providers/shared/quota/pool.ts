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
export const USAGE_FRESH_MS = 12 * 60_000;

export const isFresh = (row: UsageRow, now = Date.now()) => !row.stale && !!row.checkedAt
  && now - row.checkedAt < USAGE_FRESH_MS && (!row.resetAt || row.resetAt > now);

/**
 * Rows as they stand now. A window whose reset has passed has refilled,
 * whatever it read before, so it reports full with no reset rather than
 * being discarded as unknown until the next poll replaces it. Freshness
 * still comes from `checkedAt`: a failed or old reading stays unknown.
 */
export function rollOver(rows: UsageRow[], now = Date.now()): UsageRow[] {
  return rows.map((row) => (row.resetAt !== undefined && row.resetAt <= now
    ? { ...row, remaining: 100, resetAt: undefined }
    : row));
}

/** Aggregate a provider's reporting accounts, optionally accepting a partial pool. */
export function pooledWindow(
  rows: UsageRow[],
  label: string,
  expected: number,
  isMember: (row: UsageRow) => boolean,
  now = Date.now(),
  allowPartial = false,
) {
  const matching = rows.filter((r) => isMember(r) && r.label === label && isFresh(r, now));
  const partial = matching.length !== expected;
  if (!expected || !matching.length || (partial && !allowPartial)) return undefined;
  const weighted = matching.every((r) => typeof r.capacity === "number" && r.capacity > 0);
  const total = matching.reduce((sum, r) => sum + (weighted ? r.capacity! : 1), 0);
  const remaining = matching.reduce((sum, r) => sum + r.remaining * (weighted ? r.capacity! : 1), 0) / total;
  const resets = matching.map((r) => r.resetAt).filter((t): t is number => !!t && t > now);
  return { label, remaining, resetAt: resets.length ? Math.min(...resets) : undefined, estimated: !weighted, partial };
}
