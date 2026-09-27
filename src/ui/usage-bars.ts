import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Cell, UsageView } from "../providers/shared/quota/view.ts";
import { formatShortReset, hasTruecolor, levelColor, themeLevel } from "./format.ts";

function renderCell(theme: any, cell: Cell, labelWidth: number, cellWidth: number): string {
  const label = theme.fg(cell.active ? "accent" : "muted", cell.label.slice(0, labelWidth).padEnd(labelWidth));
  const reset = formatShortReset(cell.resetAt);
  const resetWidth = 4;
  // label, space, bar, space, 5-wide percent, space, reset: exactly cellWidth,
  // so every row's right column starts under its title.
  const barWidth = Math.max(4, cellWidth - labelWidth - resetWidth - 8);

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

export function renderUsageLines(state: UsageView, theme: any, width: number): string[] {
  if (state.loading) return [theme.fg("dim", "  usage: loading…")];
  if (state.empty) {
    if (state.errors.length > 0) return state.errors.map((error) => theme.fg("warning", `  ${error}`));
    return [theme.fg("dim", "  usage: unavailable")];
  }

  const gap = 3;
  const cellWidth = Math.max(22, Math.floor((width - 2 - gap) / 2));
  const labelWidth = 6;
  const [leftColumn, rightColumn] = state.columns;
  const lines = [`  ${theme.fg("accent", leftColumn.title.padEnd(cellWidth))}${" ".repeat(gap)}${theme.fg("accent", rightColumn.title)}`];

  for (let index = 0; index < Math.max(leftColumn.cells.length, rightColumn.cells.length); index += 1) {
    const left = leftColumn.cells[index] ? renderCell(theme, leftColumn.cells[index], labelWidth, cellWidth) : " ".repeat(cellWidth);
    const right = rightColumn.cells[index] ? renderCell(theme, rightColumn.cells[index], labelWidth, cellWidth) : "";
    lines.push(`  ${left}${" ".repeat(gap)}${right}`);
  }

  // Per-account detail. With more than two accounts only the two most recently
  // used are shown, so the footer stays two lines regardless of pool size.
  const accountLine = state.accountSummary?.slice(0, cellWidth * 2);
  if (accountLine) lines.push(`  ${theme.fg("dim", accountLine)}`);

  for (const error of state.errors) lines.push(theme.fg("warning", `  ${error}`));
  return lines.map((line) => truncateToWidth(line, width, ""));
}
