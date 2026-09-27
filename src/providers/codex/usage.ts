import { claimsOf } from "./store.ts";
import { accountRetryAt } from "../shared/accounts/provider-errors.ts";
import type { QuotaSnapshot } from "../shared/quota/snapshot.ts";
import type { UsageRow } from "../shared/quota/pool.ts";
import { primaryOAuth, readAuthFile, pct, resetToMs, TIMEOUT_MS, type StoredOAuth, type SourceOptions } from "../shared/quota/source.ts";

/**
 * The ChatGPT account the token belongs to. It must come from the same
 * credential: an id taken from a pooled account while the token is pi's
 * primary asks the endpoint about one account on behalf of another.
 */
function codexAccountId(credential: StoredOAuth): string | undefined {
  for (const value of [credential.accountId, credential.account_id, claimsOf(credential.access).accountId]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export async function fetchCodexRows(
  ctx: any,
  options: SourceOptions = {},
): Promise<{ rows: UsageRow[]; error?: string; plan?: string; retryAt?: number; quota?: QuotaSnapshot }> {
  try {
    const primary = await primaryOAuth(ctx, "openai-codex", options.readCredential ?? readAuthFile);
    if (!primary) return { rows: [], error: "Codex: not logged in" };
    const token = primary.access;
    const accountId = codexAccountId(primary);
    if (!accountId) return { rows: [], error: "Codex: no ChatGPT account id" };

    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { rows: [], error: `Codex: HTTP ${response.status}`,
      ...(response.status === 429 && { retryAt: accountRetryAt({ "retry-after": response.headers.get("retry-after") ?? "" }) }) };
    const body = await response.json() as any;

    const rows: UsageRow[] = [];
    const quota: QuotaSnapshot = { checkedAt: Date.now(), source: "poll" };
    const push = (label: string, window: any, modelId?: string) => {
      const used = pct(window?.used_percent);
      if (used === undefined) return;
      const resetAt = resetToMs(window?.reset_at);
      rows.push({ group: "Codex", label, remaining: 100 - used, resetAt, checkedAt: quota.checkedAt! });
      const measured = { utilization: used, remainingPercent: 100 - used, checkedAt: quota.checkedAt,
        ...(resetAt !== undefined && { resetsAt: new Date(resetAt).toISOString() }) };
      if (!modelId && label === "5h") quota.five_hour = measured;
      else if (!modelId && label === "weekly") quota.seven_day = measured;
      else (quota.scoped ??= []).push({ ...measured, ...(modelId && { id: modelId }) });
    };

    const kindOf = (window: any): string | undefined => {
      const seconds = Number(window?.limit_window_seconds);
      if (!Number.isFinite(seconds)) return undefined;
      if (seconds <= 21_600) return "5h";
      if (seconds >= 500_000) return "weekly";
      return `${Math.round(seconds / 86400)}d`;
    };

    for (const window of [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]) {
      const kind = kindOf(window);
      if (kind) push(kind, window);
    }

    for (const extra of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
      const name = String(extra?.limit_name ?? "extra").replace(/^GPT-[\d.]+-Codex-/i, "");
      for (const window of [extra?.rate_limit?.primary_window, extra?.rate_limit?.secondary_window]) {
        const kind = kindOf(window);
        if (kind) push(`${name} ${kind}`, window, String(extra?.limit_name ?? "extra"));
      }
    }

    const credits = body.credits;
    if (credits?.has_credits && credits?.balance) {
      rows.push({ group: "Codex", label: `credits ${credits.balance}`, remaining: 100, checkedAt: Date.now() });
    }

    return { rows, plan: typeof body.plan_type === "string" ? body.plan_type : undefined,
      ...(quota.five_hour || quota.seven_day || quota.scoped?.length ? { quota } : {}) };
  } catch (error) {
    return { rows: [], error: `Codex: ${error instanceof Error ? error.message : String(error)}` };
  }
}
