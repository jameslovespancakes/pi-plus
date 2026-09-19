const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g;

/** Flattens arbitrary text into one stable, printable row. */
export function toDisplayLine(text: string, maxLength = 120): string {
  const flat = text
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (maxLength <= 0 || flat.length <= maxLength) return flat;
  return `${flat.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
