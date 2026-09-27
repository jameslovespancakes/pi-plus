import { isFresh, pooledWindow, type UsageRow } from "../shared/quota/pool.ts";

export const isClaudeAccount = (row: UsageRow) => row.group.startsWith("Claude ") && !row.group.startsWith("Claude pool ×");

/** Percent of combined capacity, not a claim that quota transfers between accounts.
 * Without published capacities this is explicitly an equal-account estimate.
 */
export function combinedWindow(rows: UsageRow[], label: string, expected: number, now = Date.now(), allowPartial = false) {
  return pooledWindow(rows, label, expected, isClaudeAccount, now, allowPartial);
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
