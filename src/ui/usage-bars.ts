import { truncateToWidth } from "@earendil-works/pi-tui";
import { geminiQuotaFamily, GEMINI_QUOTA_FAMILIES } from "../core/gemini/quota.ts";
import {
  combinedWindow,
  isClaudeAccount,
  isFresh,
  isGeminiAccount,
  OBSERVED_PROVIDERS,
  poolAvailability,
  pooledWindow,
  scopedLabels,
  type UsageRow,
} from "../core/quota/pool.ts";
import type { UsageState } from "../services/usage-service.ts";
import { formatReset, formatShortReset, hasTruecolor, levelColor, themeLevel } from "./format.ts";

/**
 * Renders the quota bars: Claude on the left, and on the right the provider in
 * use: Gemini, Kimi or Grok while one of their models is selected, Codex
 * otherwise. Takes state as an argument rather than importing the service, so
 * the renderer stays a pure function of its input.
 */

type Cell = { label: string; remaining?: number; resetAt?: number; partial?: boolean; active?: boolean };
type Column = { title: string; cells: Cell[] };

/** The session's current model; its provider picks the right-hand column. */
export interface ActiveModel {
  provider?: string;
  modelId?: string;
}

function pooled(state: UsageState, label: string): Cell | undefined {
  return combinedWindow(state.rows, label, state.accounts, Date.now(), true);
}

function codexCell(state: UsageState, display: string, match: (label: string) => boolean): Cell | undefined {
  const row = state.rows.find((candidate) => candidate.group === "Codex" && match(candidate.label));
  return row ? { label: display, remaining: row.remaining, resetAt: row.resetAt } : { label: display };
}

/** Gemini accounts the pool expects, falling back to those that reported. */
function geminiExpected(state: UsageState): number {
  return state.geminiAccounts || new Set(state.rows.filter(isGeminiAccount).map((row) => row.group)).size;
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

function claudeColumn(state: UsageState, modelId?: string): Column {
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

function codexColumn(state: UsageState): Column {
  // Codex reports only the two windows; it has no scoped equivalent.
  const cells: Cell[] = [
    codexCell(state, "5h", (label) => label === "5h") ?? { label: "5h" },
    codexCell(state, "weekly", (label) => label === "weekly") ?? { label: "weekly" },
  ];
  return { title: state.codexPlan ? `Codex · ${state.codexPlan}` : "Codex", cells };
}

/**
 * Gemini pools quota per model family, so each bar is a family. The third is
 * whichever third-party family is in use (Claude unless GPT-OSS is), and the
 * active family's label is highlighted.
 */
function geminiColumn(state: UsageState, modelId?: string): Column {
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

/** `Work 61% · Personal 88%`. Empty when there is nothing extra to say. */
function renderAccountSummary(state: UsageState, cellWidth: number): string | undefined {
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
  return text.length > cellWidth * 2 ? text.slice(0, cellWidth * 2) : text;
}

function renderCell(theme: any, cell: Cell, labelWidth: number, cellWidth: number): string {
  const label = theme.fg(cell.active ? "accent" : "muted", cell.label.slice(0, labelWidth).padEnd(labelWidth));
  const reset = formatShortReset(cell.resetAt);
  const resetWidth = 4;
  const barWidth = Math.max(4, cellWidth - labelWidth - 6 - resetWidth - 3);

  if (cell.remaining === undefined) {
    return `${label} ${theme.fg("dim", "·".repeat(barWidth))} ${theme.fg("dim", "  n/a")}${" ".repeat(resetWidth + 1)}`;
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

  return `${label} ${bar} ${percent} ${theme.fg("dim", reset.padEnd(resetWidth))}`;
}

export function renderUsageLines(state: UsageState, theme: any, width: number, active?: ActiveModel): string[] {
  if (state.loading) return [theme.fg("dim", "  usage: loading…")];
  if (state.rows.length === 0) {
    if (state.errors.length > 0) return state.errors.map((error) => theme.fg("warning", `  ${error}`));
    return [theme.fg("dim", "  usage: unavailable")];
  }

  const gap = 3;
  const cellWidth = Math.max(22, Math.floor((width - 2 - gap) / 2));
  const labelWidth = 6;
  // Claude's scoped limit follows the model only while Anthropic serves it;
  // the same Claude id through Gemini draws on Gemini's quota instead.
  const claude = claudeColumn(state, active?.provider === "anthropic" ? active.modelId : undefined);
  const side = sideColumn(state, active);
  const lines = [`  ${theme.fg("accent", claude.title.padEnd(cellWidth))}${" ".repeat(gap)}${theme.fg("accent", side.title)}`];

  for (let index = 0; index < Math.max(claude.cells.length, side.cells.length); index += 1) {
    const left = claude.cells[index] ? renderCell(theme, claude.cells[index], labelWidth, cellWidth) : " ".repeat(cellWidth);
    const right = side.cells[index] ? renderCell(theme, side.cells[index], labelWidth, cellWidth) : "";
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
  // Gemini's combined figures only add information with more than one account.
  const geminiAccounts = geminiExpected(state);
  const gemini = geminiAccounts > 1 ? GEMINI_QUOTA_FAMILIES.flatMap((label) => {
    const pool = pooledWindow(state.rows, label, geminiAccounts, isGeminiAccount, Date.now(), true);
    return pool
      ? [`Gemini combined ${label}: ${pool.partial ? "~" : ""}${Math.round(pool.remaining)}% left ${formatReset(pool.resetAt)}`.trim()]
      : [];
  }) : [];
  const summary = [...combined, ...gemini, ...state.rows.map(
    (row: UsageRow) => `${row.group} ${row.label}: ${Math.round(row.remaining)}% left ${formatReset(row.resetAt)}${row.stale ? " (stale)" : ""}`.trim(),
  )];
  return [...summary, ...state.errors].join("\n") || "No usage data";
}
