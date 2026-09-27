import { claudeColumn, renderAccountSummary, claudeSummary, claudeQuotaLeft } from "../anthropic/usage-view.ts";
import { geminiColumn, geminiSummary, geminiQuotaLeft } from "../gemini/usage-view.ts";
import { isGeminiAccount } from "../gemini/quota.ts";
import { codexColumn, codexQuotaLeft } from "../codex/usage-view.ts";
import { OBSERVED_PROVIDERS } from "./observed-providers.ts";
import { rollOver } from "../shared/quota/pool.ts";
import type { Column, ActiveModel, UsageView } from "../shared/quota/view.ts";
import type { UsageState } from "./service.ts";
import { formatReset } from "../../ui/format.ts";

/** Provider composition; the renderer receives only columns and text. */
/** Providers with no usage endpoint: the last rate-limit reading, if any. */
function observedColumn(state: UsageState, group: string): Column {
  const row = state.rows.find((candidate) => candidate.group === group && candidate.label === "rate");
  return row
    ? { title: group, cells: [{ label: "rate", remaining: row.remaining, resetAt: row.resetAt }] }
    : { title: `${group} · usage not reported`, cells: [] };
}

/** The right-hand column: the active provider's, else Codex. */
function sideColumn(state: UsageState, active?: ActiveModel): Column {
  if (active?.provider === "gemini") return geminiColumn(state, active.modelId);
  if (active?.provider === "openai-codex") return codexColumn(state);
  const observed = OBSERVED_PROVIDERS.find(([providerId]) => providerId === active?.provider);
  if (observed) return observedColumn(state, observed[1]);
  // Nothing more specific in use: Codex, unless only Gemini has figures.
  const codex = state.rows.some((row) => row.group === "Codex");
  return !codex && state.rows.some(isGeminiAccount) ? geminiColumn(state) : codexColumn(state);
}

export function createUsageView(raw: UsageState, active?: ActiveModel): UsageView {
  const state = { ...raw, rows: rollOver(raw.rows) };
  return {
    loading: state.loading, empty: state.rows.length === 0, errors: state.errors,
    columns: [claudeColumn(state, active?.provider === "anthropic" ? active.modelId : undefined), sideColumn(state, active)],
    accountSummary: renderAccountSummary(state),
  };
}

export function usageSummaryText(raw: UsageState): string {
  const state = { ...raw, rows: rollOver(raw.rows) };
  const summary = [...claudeSummary(state), ...geminiSummary(state), ...state.rows.map(
    (row) => `${row.group} ${row.label}: ${Math.round(row.remaining)}% left ${formatReset(row.resetAt)}${row.stale ? " (stale)" : ""}`.trim(),
  )];
  return [...summary, ...state.errors].join("\n") || "No usage data";
}

export function quotaLeft(raw: UsageState, provider: string, modelId: string): number | undefined {
  const state = { ...raw, rows: rollOver(raw.rows) };
  if (provider === "anthropic") return claudeQuotaLeft(state);
  if (provider === "gemini") return geminiQuotaLeft(state, modelId);
  if (provider === "openai-codex") return codexQuotaLeft(state);
  return undefined;
}
