import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAccounts, refreshToken, saveAccount, type AnthropicAccount } from "../../vendor/anthropic.ts";
import type { UsageRow } from "./pool.ts";

/**
 * Fetches subscription quota from the Claude and Codex endpoints.
 *
 * Pure data access: no pi imports, no module-level mutable state, no rendering.
 * Everything here returns values so it can be tested without a live agent.
 * Scheduling, caching and retention belong to services/usage-service.ts.
 */

const TIMEOUT_MS = 10_000;

export interface SourceResult {
  rows: UsageRow[];
  errors: string[];
  groups: string[];
  codexPlan?: string;
}

function pct(value: unknown): number | undefined {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
}

function resetToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

async function claudeUsage(group: string, token: string): Promise<{ rows: UsageRow[]; error?: string }> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return { rows: [], error: `${group}: HTTP ${response.status}` };
  const body = await response.json() as any;

  const rows: UsageRow[] = [];
  const push = (label: string, window: any) => {
    const used = pct(window?.utilization);
    if (used === undefined) return;
    rows.push({
      group,
      label,
      remaining: 100 - used,
      resetAt: resetToMs(window?.resets_at),
      capacity: typeof window?.limit_dollars === "number" && window.limit_dollars > 0 ? window.limit_dollars : undefined,
    });
  };
  push("5h", body.five_hour);
  push("7d", body.seven_day);
  push("7d Opus", body.seven_day_opus ?? body.seven_day_omelette);
  push("7d Sonnet", body.seven_day_sonnet);

  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    const scoped = limit?.scope?.model?.display_name;
    const used = pct(limit?.percent);
    if (!scoped || used === undefined) continue;
    const label = `7d ${scoped}`;
    if (rows.some((row) => row.label === label)) continue;
    rows.push({ group, label, remaining: 100 - used, resetAt: resetToMs(limit?.resets_at) });
  }

  const extra = body.extra_usage;
  if (extra?.is_enabled && pct(extra?.utilization) !== undefined) {
    rows.push({ group, label: "Extra", remaining: 100 - pct(extra.utilization)! });
  }

  return rows.length
    ? { rows: rows.map((row) => ({ ...row, checkedAt: Date.now() })) }
    : { rows: [], error: `${group}: usage windows unavailable` };
}

/**
 * HUD polling must never wait indefinitely on OAuth refresh or retry it behind
 * a live agent turn. The provider owns request-time refresh/retry policy.
 */
async function fallbackAccountToken(account: AnthropicAccount): Promise<string | undefined> {
  const valid = typeof account.expires === "number" && Date.now() + 60_000 < account.expires;
  if (valid && account.access) return account.access;
  if (!account.refresh) return account.access;

  const refreshed = await refreshToken(account.refresh, { maxRetries: 0, timeoutMs: TIMEOUT_MS });
  await saveAccount({
    ...account,
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    lastRefreshedAt: Date.now(),
  });
  return refreshed.access;
}

export async function fetchClaudeRows(ctx: any): Promise<{ rows: UsageRow[]; errors: string[]; groups: string[] }> {
  const rows: UsageRow[] = [];
  const errors: string[] = [];
  const accounts: Array<{ group: string; token?: string; account?: AnthropicAccount }> = [];

  try {
    const token = (await ctx.modelRegistry.getProviderAuth("anthropic"))?.auth?.apiKey;
    if (token) accounts.push({ group: "Claude Personal", token });
    else errors.push("Claude Personal: not logged in");
  } catch (error) {
    errors.push(`Claude Personal: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const storage = await loadAccounts();
    for (const account of storage?.accounts ?? []) {
      if (account.type !== "oauth" || account.enabled === false) continue;
      accounts.push({ group: `Claude ${account.label ?? account.id.slice(0, 8)}`, account });
    }
  } catch (error) {
    errors.push(`Claude accounts: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const entry of accounts) {
    try {
      const token = entry.token ?? (entry.account ? await fallbackAccountToken(entry.account) : undefined);
      if (!token) {
        errors.push(`${entry.group}: no token`);
        continue;
      }
      const result = await claudeUsage(entry.group, token);
      rows.push(...result.rows);
      if (result.error) errors.push(result.error);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(/invalid_grant/i.test(message)
        ? `${entry.group}: login expired, run /account anthropic reauth ${entry.account?.label ?? entry.account?.id ?? ""}`.trim()
        : `${entry.group}: ${message}`);
    }
  }

  return { rows, errors, groups: [...new Set(["Claude Personal", ...accounts.map((entry) => entry.group)])] };
}

function codexAccountId(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const credential = auth["openai-codex"];
    if (credential?.accountId) return credential.accountId;
    if (credential?.account_id) return credential.account_id;
  } catch { /* fall through */ }
  try {
    const codex = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    return codex?.tokens?.account_id ?? codex?.tokens?.accountId;
  } catch {
    return undefined;
  }
}

export async function fetchCodexRows(ctx: any): Promise<{ rows: UsageRow[]; error?: string; plan?: string }> {
  try {
    const token = (await ctx.modelRegistry.getProviderAuth("openai-codex"))?.auth?.apiKey;
    const accountId = codexAccountId();
    if (!token) return { rows: [], error: "Codex: not logged in" };
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { rows: [], error: `Codex: HTTP ${response.status}` };
    const body = await response.json() as any;

    const rows: UsageRow[] = [];
    const push = (label: string, window: any) => {
      const used = pct(window?.used_percent);
      if (used === undefined) return;
      rows.push({ group: "Codex", label, remaining: 100 - used, resetAt: resetToMs(window?.reset_at), checkedAt: Date.now() });
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
        const used = pct(window?.used_percent);
        if (!kind || used === undefined) continue;
        rows.push({
          group: "Codex",
          label: `${name} ${kind}`,
          remaining: 100 - used,
          resetAt: resetToMs(window?.reset_at),
          checkedAt: Date.now(),
        });
      }
    }

    const credits = body.credits;
    if (credits?.has_credits && credits?.balance) {
      rows.push({ group: "Codex", label: `credits ${credits.balance}`, remaining: 100, checkedAt: Date.now() });
    }

    return { rows, plan: typeof body.plan_type === "string" ? body.plan_type : undefined };
  } catch (error) {
    return { rows: [], error: `Codex: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** One full poll of every configured subscription source. */
export async function fetchAll(ctx: any): Promise<SourceResult> {
  const [claude, codex] = await Promise.all([fetchClaudeRows(ctx), fetchCodexRows(ctx)]);
  return {
    rows: [...claude.rows, ...codex.rows],
    errors: [...claude.errors, codex.error].filter((error): error is string => !!error),
    groups: claude.groups,
    codexPlan: codex.plan,
  };
}
