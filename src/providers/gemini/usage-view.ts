import type { UsageState } from "../usage/service.ts";
import type { Cell, Column } from "../shared/quota/view.ts";
import { formatReset } from "../../ui/format.ts";
import { pooledWindow, isFresh } from "../shared/quota/pool.ts";
import { geminiQuotaFamily, GEMINI_QUOTA_FAMILIES, isGeminiAccount } from "./quota.ts";

/** Gemini accounts the pool expects, falling back to those that reported. */
function geminiExpected(state: UsageState): number {
  return state.geminiAccounts || new Set(state.rows.filter(isGeminiAccount).map((row) => row.group)).size;
}

/**
 * Gemini pools quota per model family, so each bar is a family. The third is
 * whichever third-party family is in use (Claude unless GPT-OSS is), and the
 * active family's label is highlighted.
 */
export function geminiColumn(state: UsageState, modelId?: string): Column {
  const expected = geminiExpected(state);
  const active = geminiQuotaFamily(modelId);
  const labels = ["Flash", "Pro", active === "GPT" ? "GPT" : "Claude"];
  const cells: Cell[] = labels.map((label) => ({
    ...(pooledWindow(state.rows, label, expected, isGeminiAccount, Date.now(), true) ?? {}),
    label,
    active: label === active,
  }));

  let title = expected > 1 ? `Gemini Σ${expected}` : "Gemini";
  if (active && expected > 0) {
    // Ready = can serve the active model now: its family has quota left.
    const groups = [...new Set(state.rows.filter(isGeminiAccount).map((row) => row.group))];
    let ready = 0;
    let unknown = Math.max(0, expected - groups.length);
    for (const group of groups) {
      const row = state.rows.find((candidate) => candidate.group === group && candidate.label === active);
      if (!row || !isFresh(row)) unknown++;
      else if (row.remaining > 0) ready++;
    }
    title += ` · ${ready ? `${ready}/${expected} ready` : unknown ? "unknown/stale" : "exhausted"}`;
  }
  return { title, cells };
}

export function geminiSummary(state: UsageState): string[] {
  const expected = geminiExpected(state);
  return expected > 1 ? GEMINI_QUOTA_FAMILIES.flatMap((label) => {
    const pool = pooledWindow(state.rows, label, expected, isGeminiAccount, Date.now(), true);
    return pool ? [`Gemini combined ${label}: ${pool.partial ? "~" : ""}${Math.round(pool.remaining)}% left ${formatReset(pool.resetAt)}`.trim()] : [];
  }) : [];
}
export function geminiQuotaLeft(state: UsageState, modelId: string): number | undefined {
  const family = geminiQuotaFamily(modelId);
  const pool = family ? pooledWindow(state.rows, family, geminiExpected(state), isGeminiAccount, Date.now(), true) : undefined;
  return pool ? Math.round(pool.remaining) : undefined;
}
