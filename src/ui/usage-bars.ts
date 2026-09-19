import { truncateToWidth } from "@earendil-works/pi-tui";
import { combinedWindow, isClaudeAccount, poolAvailability, scopedLabels, type UsageRow } from "../core/quota/pool.ts";
import type { UsageState } from "../services/usage-service.ts";
import { formatReset, formatShortReset, hasTruecolor, levelColor, themeLevel } from "./format.ts";

/**
 * Renders the Claude/Codex quota bars. Takes state as an argument rather than
 * importing the service, so the renderer stays a pure function of its input.
 */

type Cell = { label: string; remaining?: number; resetAt?: number; partial?: boolean };

function pooled(state: UsageState, label: string): Cell | undefined {
  return combinedWindow(state.rows, label, state.accounts, Date.now(), true);
}

function codexCell(state: UsageState, display: string, match: (label: string) => boolean): Cell | undefined {
  const row = state.rows.find((candidate) => candidate.group === "Codex" && match(candidate.label));
  return row ? { label: display, remaining: row.remaining, resetAt: row.resetAt } : { label: display };
}

function buildColumns(state: UsageState, modelId?: string): { claude: Cell[]; codex: Cell[] } {
  const scopes = scopedLabels(state.rows, modelId);
  const claude: Cell[] = [
    pooled(state, "5h") ?? { label: "5h" },
    { ...(pooled(state, "7d") ?? { label: "7d" }), label: "weekly" },
    ...scopes.map((scoped) => ({ ...(pooled(state, scoped) ?? { label: scoped }), label: scoped.replace("7d ", "") })),
    ...(scopes.length ? [] : [{ label: "—" }]),
  ];
  claude[0] = { ...claude[0], label: "5h" };

  const codex: Cell[] = [
    codexCell(state, "5h", (label) => label === "5h") ?? { label: "5h" },
    codexCell(state, "weekly", (label) => label === "weekly") ?? { label: "weekly" },
    codexCell(state, "Spark", (label) => /spark/i.test(label) && label.endsWith("5h"))
      ?? codexCell(state, "Spark", (label) => /spark/i.test(label))
      ?? { label: "Spark" },
  ];
  return { claude, codex };
}

/** `Work 61% · Personal 88%` — empty when there is nothing extra to say. */
function renderAccountSummary(state: UsageState, cellWidth: number): string | undefined {
  const stamps = state.lastUsedAt ?? {};
  const groups = [...new Set(state.rows.filter(isClaudeAccount).map((row) => row.group))];
  if (groups.length < 2) return undefined;

  const ordered = groups.sort((a, b) => (stamps[b] ?? 0) - (stamps[a] ?? 0) || a.localeCompare(b));
  const shown = ordered.slice(0, 2);

  const parts = shown.map((group) => {
    const row = state.rows.find((candidate) => candidate.group === group && candidate.label === "5h");
    const name = group.replace(/^Claude /, "");
    if (!row) return `${name} —`;
    return `${name} ${Math.round(row.remaining)}%${row.stale ? "*" : ""}`;
  });

  const hidden = ordered.length - shown.length;
  const text = parts.join(" · ") + (hidden > 0 ? ` +${hidden}` : "");
  return text.length > cellWidth * 2 ? text.slice(0, cellWidth * 2) : text;
}

function renderCell(theme: any, cell: Cell, labelWidth: number, cellWidth: number): string {
  const label = cell.label.slice(0, labelWidth).padEnd(labelWidth);
  const reset = formatShortReset(cell.resetAt);
  const resetWidth = 4;
  const barWidth = Math.max(4, cellWidth - labelWidth - 6 - resetWidth - 3);

  if (cell.remaining === undefined) {
    return `${theme.fg("muted", label)} ${theme.fg("dim", "·".repeat(barWidth))} ${theme.fg("dim", "  n/a")}${" ".repeat(resetWidth + 1)}`;
  }

  const filled = Math.round((cell.remaining / 100) * barWidth);
  const percentText = `${cell.partial ? "~" : ""}${Math.round(cell.remaining)}%`.padStart(5);
  let bar: string;
  let percent: string;

  if (hasTruecolor()) {
    // One smooth hue per bar: green when full, amber mid-way, red as it empties.
    const paint = levelColor(cell.remaining);
    bar = paint("█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
    percent = paint(percentText);
  } else {
    const color = themeLevel(cell.remaining);
    bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
    percent = theme.fg(color, percentText);
  }

  return `${theme.fg("muted", label)} ${bar} ${percent} ${theme.fg("dim", reset.padEnd(resetWidth))}`;
}

export function renderUsageLines(state: UsageState, theme: any, width: number, modelId?: string): string[] {
  if (state.loading) return [theme.fg("dim", "  usage: loading…")];
  if (state.rows.length === 0) {
    if (state.errors.length > 0) return state.errors.map((error) => theme.fg("warning", `  ${error}`));
    return [theme.fg("dim", "  usage: unavailable")];
  }

  const gap = 3;
  const cellWidth = Math.max(22, Math.floor((width - 2 - gap) / 2));
  const labelWidth = 6;
  const { claude, codex } = buildColumns(state, modelId);
  const availability = poolAvailability(state.rows, state.accounts, modelId);
  const status = availability.ready
    ? `${availability.ready}/${availability.total} ready`
    : availability.unknown ? "unknown/stale" : "exhausted";
  const partial = claude.some((cell) => cell.partial);
  const claudeTitle = `Claude Σ${state.accounts} · ${status}${partial ? " · partial" : ""}`;
  const codexTitle = state.codexPlan ? `Codex · ${state.codexPlan}` : "Codex";
  const lines = [`  ${theme.fg("accent", claudeTitle.padEnd(cellWidth))}${" ".repeat(gap)}${theme.fg("accent", codexTitle)}`];

  for (let index = 0; index < Math.max(claude.length, codex.length); index += 1) {
    const left = claude[index] ? renderCell(theme, claude[index], labelWidth, cellWidth) : " ".repeat(cellWidth);
    const right = codex[index] ? renderCell(theme, codex[index], labelWidth, cellWidth) : "";
    lines.push(`  ${left}${" ".repeat(gap)}${right}`);
  }

  // Per-account detail. With more than two accounts only the two most recently
  // used are shown, so the footer stays two lines regardless of pool size.
  const accountLine = renderAccountSummary(state, cellWidth);
  if (accountLine) lines.push(`  ${theme.fg("dim", accountLine)}`);

  for (const error of state.errors) lines.push(theme.fg("warning", `  ${error}`));
  return lines.map((line) => truncateToWidth(line, width, ""));
}

export function usageSummaryText(state: UsageState): string {
  const combined = ["5h", "7d", ...scopedLabels(state.rows)].map((label) => {
    const pool = combinedWindow(state.rows, label, state.accounts, Date.now(), true);
    return `Claude combined ${label}: ${pool
      ? `${pool.partial ? "~" : ""}${Math.round(pool.remaining)}% left${pool.partial ? " (partial: reporting accounts only)" : ""} ${formatReset(pool.resetAt)}`
      : "unknown/stale"}`;
  });
  const summary = [...combined, ...state.rows.map(
    (row: UsageRow) => `${row.group} ${row.label}: ${Math.round(row.remaining)}% left ${formatReset(row.resetAt)}${row.stale ? " (stale)" : ""}`.trim(),
  )];
  return [...summary, ...state.errors].join("\n") || "No usage data";
}
