/** Presentation helpers with no domain knowledge. */

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Keep long ids readable by trimming the middle rather than the tail. */
export function fitId(id: string, width: number): string {
  if (id.length <= width) return id.padEnd(width);
  return `${id.slice(0, 12)}…${id.slice(id.length - (width - 13))}`;
}

export function formatShortReset(resetAt?: number): string {
  if (!resetAt) return "";
  const seconds = Math.max(0, Math.round((resetAt - Date.now()) / 1000));
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatReset(resetAt?: number): string {
  if (!resetAt) return "";
  const seconds = Math.max(0, Math.round((resetAt - Date.now()) / 1000));
  if (seconds < 60) return "resets <1m";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `resets ${days}d ${hours}h`;
  if (hours > 0) return `resets ${hours}h ${minutes}m`;
  return `resets ${minutes}m`;
}

const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || !!process.env.WT_SESSION;

export function hasTruecolor(): boolean {
  return TRUECOLOR;
}

function hslToAnsi(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, secondary, 0]
    : hue < 120 ? [secondary, chroma, 0]
    : hue < 180 ? [0, chroma, secondary]
    : hue < 240 ? [0, secondary, chroma]
    : hue < 300 ? [secondary, 0, chroma]
    : [chroma, 0, secondary];
  const to255 = (value: number) => Math.round((value + match) * 255);
  return `\u001b[38;2;${to255(r)};${to255(g)};${to255(b)}m`;
}

/** Smooth red (empty) to green (full) ramp for a 0-100 fullness value. */
export function levelColor(remaining: number): (text: string) => string {
  const clamped = Math.min(100, Math.max(0, remaining));
  if (!TRUECOLOR) return (text: string) => text;
  const hue = 120 * Math.pow(clamped / 100, 1.35);
  const lightness = clamped <= 12 ? 0.58 : 0.48;
  const escape = hslToAnsi(hue, 0.85, lightness);
  return (text: string) => `${escape}${text}\u001b[39m`;
}

export function themeLevel(remaining: number): "error" | "warning" | "success" {
  return remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "success";
}
