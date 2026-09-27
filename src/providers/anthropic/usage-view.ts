import type { UsageState } from "../usage/service.ts";
import type { Cell, Column } from "../shared/quota/view.ts";
import { formatReset } from "../../ui/format.ts";
import { combinedWindow, isClaudeAccount, scopedLabels, poolAvailability } from "./usage-pool.ts";

function pooled(state: UsageState, label: string): Cell | undefined {
  return combinedWindow(state.rows, label, state.accounts, Date.now(), true);
}

/**
 * Turns a scoped limit id into something that fits the label column.
 *
 * Anthropic names these with an internal id, e.g.
 * `7d claude-weekly-scoped-fable`. Rendered raw it was truncated to the 6
 * column label width and came out as "claude", which named neither the window
 * nor the model. The trailing segment is the model family, so that is what is
 * shown.
 */
function scopedDisplayName(label: string): string {
  const family = label.replace(/^7d\s+/, "").split("-").pop() ?? label;
  return family.charAt(0).toUpperCase() + family.slice(1);
}

export function claudeColumn(state: UsageState, modelId?: string): Column {
  // Three fixed tiers, so the block keeps its shape whether or not a scoped
  // limit is currently reported.
  const scoped = scopedLabels(state.rows, modelId)[0];
  const scopedCell = scoped
    ? { ...(pooled(state, scoped) ?? { label: scoped }), label: scopedDisplayName(scoped) }
    : { label: "Fable" };

  const cells: Cell[] = [
    { ...(pooled(state, "5h") ?? { label: "5h" }), label: "5h" },
    { ...(pooled(state, "7d") ?? { label: "7d" }), label: "weekly" },
    scopedCell,
  ];

  const availability = poolAvailability(state.rows, state.accounts, modelId);
  const status = availability.ready
    ? `${availability.ready}/${availability.total} ready`
    : availability.unknown ? "unknown/stale" : "exhausted";
  return { title: `Claude Σ${state.accounts} · ${status}`, cells };
}

/** `Work 61% · Personal 88%`. Empty when there is nothing extra to say. */
export function renderAccountSummary(state: UsageState): string | undefined {
  const stamps = state.lastUsedAt ?? {};
  const groups = [...new Set(state.rows.filter(isClaudeAccount).map((row) => row.group))];
  if (groups.length < 2) return undefined;

  const ordered = groups.sort((a, b) => (stamps[b] ?? 0) - (stamps[a] ?? 0) || a.localeCompare(b));
  const shown = ordered.slice(0, 2);

  const parts = shown.map((group) => {
    const row = state.rows.find((candidate) => candidate.group === group && candidate.label === "5h");
    const name = group.replace(/^Claude /, "");
    if (!row) return `${name} -`;
    return `${name} ${Math.round(row.remaining)}%${row.stale ? "*" : ""}`;
  });

  const hidden = ordered.length - shown.length;
  const text = parts.join(" · ") + (hidden > 0 ? ` +${hidden}` : "");
  return text;
}

export function claudeSummary(state: UsageState): string[] {
  return ["5h", "7d", ...scopedLabels(state.rows)].map((label) => {
    const pool = combinedWindow(state.rows, label, state.accounts, Date.now(), true);
    return `Claude combined ${label}: ${pool
      ? `${pool.partial ? "~" : ""}${Math.round(pool.remaining)}% left${pool.partial ? " (partial: reporting accounts only)" : ""} ${formatReset(pool.resetAt)}`
      : "unknown/stale"}`;
  });
}
export function claudeQuotaLeft(state: UsageState): number | undefined {
  const pool = combinedWindow(state.rows, "5h", state.accounts, Date.now(), true);
  return pool ? Math.round(pool.remaining) : undefined;
}
