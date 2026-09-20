const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g;
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

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

/** Sanitizes chat content while preserving the line breaks and Markdown shown by Pi. */
export function toDisplayText(text: string, maxLength = 2_000): string {
  const value = text
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(MULTILINE_CONTROL_PATTERN, " ")
    .split("\n")
    .map((line) => line.replace(/\t/g, "  ").trimEnd())
    .join("\n")
    .trim();
  if (maxLength <= 0 || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
