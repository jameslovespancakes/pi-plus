/** Without a server reset hint, allow the first scheduled fallback round. */
export const ACCOUNT_RETRY_COOLDOWN_MS = 10_000;

/** Account exhaustion is recoverable by another credential, not necessarily by the same one. */
export function isAccountLimitMessage(message: string): boolean {
  return /\b429\b|GoUsageLimitError|FreeUsageLimitError|insufficient_quota|rate_limit_error|ResourceExhausted|usage_limit_reached/i.test(message)
    || /\btoo many requests\b/i.test(message)
    || /\b(?:usage|quota|monthly|weekly|daily)\s+(?:window\s+)?limit\b/i.test(message)
    || /\bquota\s+(?:has\s+been\s+)?exceeded\b/i.test(message)
    || /\bexceeded\b[^\n]*\bquota\b/i.test(message)
    || /\b(?:usage|rate)\s+limit\s+(?:(?:has\s+been|was)\s+)?(?:reached|exceeded)\b/i.test(message);
}

export function parseProviderResetHint(message: string, now = Date.now()): { resetHint?: string; resetAt?: number } {
  const bounded = (hint: string) => hint.length <= 512 ? hint : `${hint.slice(0, 511)}…`;
  const iso = message.match(
    /(?:[a-z-]*reset[a-z-]*|resets?\s+at|available\s+again\s+at)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i,
  )?.[1];
  if (iso) {
    const at = Date.parse(iso);
    return Number.isFinite(at) && at > now ? { resetHint: bounded(iso), resetAt: at } : { resetHint: bounded(iso) };
  }
  const labelled = message.match(
    /(?:retry[- ]after|try again in|resets? in|available again in|x-ratelimit-reset(?:-[a-z-]+)?)\s*[:=]?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+)/i,
  );
  if (labelled?.[1]) {
    const delay = parseDurationMs(labelled[1]);
    return { resetHint: bounded(labelled[0]), ...(delay !== undefined && { resetAt: now + delay }) };
  }
  const retryAfter = message.match(/retry[- ]after\s*[:=]\s*([^\s,;]+)/i);
  if (retryAfter?.[1]) {
    const seconds = Number(retryAfter[1]);
    return { resetHint: bounded(retryAfter[0]), ...(Number.isFinite(seconds) && seconds >= 0 && { resetAt: now + seconds * 1_000 }) };
  }
  return {};
}

function parseDurationMs(value: string): number | undefined {
  const unitPattern = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gi;
  let total = 0;
  let matched = "";
  for (const part of value.matchAll(unitPattern)) {
    const amount = Number(part[1]);
    const unit = part[2]?.toLowerCase();
    if (!Number.isFinite(amount) || !unit) return undefined;
    matched += part[0];
    if (unit === "ms" || unit.startsWith("millisecond")) total += amount;
    else if (unit === "s" || unit.startsWith("sec")) total += amount * 1_000;
    else if (unit === "m" || unit.startsWith("min")) total += amount * 60_000;
    else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) total += amount * 3_600_000;
    else total += amount * 86_400_000;
  }
  if (!matched || value.replace(/\s+/g, "") !== matched.replace(/\s+/g, "")) return undefined;
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

/** Retry-After accepts both seconds and an HTTP date. Never shorten a server's reset hint. */
export function accountRetryAt(headers: Record<string, string>, message = "", now = Date.now()): number {
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const seconds = raw?.trim() ? Number(raw) : NaN;
  const headerAt = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1_000 : Date.parse(raw ?? "");
  const messageAt = parseProviderResetHint(message, now).resetAt;
  const hints = [headerAt, messageAt].filter((at): at is number => at !== undefined && Number.isFinite(at));
  return Math.max(now + 1_000, ...(hints.length ? hints : [now + ACCOUNT_RETRY_COOLDOWN_MS]));
}
