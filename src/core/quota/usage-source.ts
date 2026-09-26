import { loadOAuthPool, saveOAuthAccount, sharedOAuthPoolStore, type PooledOAuthAccount } from "../accounts/oauth-pool.ts";
import { refreshAbortSignal, type AccountQuotaState } from "../accounts/routing.ts";
import { anthropicAccountIdentity, cachedAnthropicAccountIdentity } from "../anthropic/identity.ts";
import { loadAccounts, type Account as AnthropicAccount } from "../anthropic/store.ts";
import { ensureAccessToken } from "../anthropic/quota.ts";
import { readClaudeQuota } from "../anthropic/usage-cache.ts";
import { claimsOf } from "../codex/store.ts";
import { fetchUserQuota, GeminiVerificationRequiredError } from "../gemini/client.ts";
import { credentialEmail } from "../gemini/credentials.ts";
import { geminiOAuth, requestProjectId } from "../gemini/oauth.ts";
import { summarizeGeminiQuota } from "../gemini/quota.ts";
import { agentPath, readJson } from "../store.ts";
import { CLAUDE_FRESH_MS, OBSERVED_PROVIDERS, type UsageRow } from "./pool.ts";

/**
 * Fetches subscription quota from the Claude, Codex and Gemini endpoints, and
 * reports what response headers showed for providers with no usage endpoint.
 *
 * No pi imports or rendering. Claude quota/cooldown is shared in usage-cache.ts;
 * display scheduling and retention belong to services/usage-service.ts.
 */

const TIMEOUT_MS = 10_000;

export interface SourceResult {
  rows: UsageRow[];
  errors: string[];
  /** Claude account groups expected to report. */
  groups: string[];
  /** Gemini account groups expected to report. */
  geminiGroups: string[];
  codexPlan?: string;
}

/** Reads a provider's credential as pi stores it (pi's `readStoredCredential`). */
export type CredentialReader = (providerId: string) => unknown;

export interface SourceOptions {
  /**
   * How the primary (pi-owned) credential is read. It must be read as stored:
   * `modelRegistry.getProviderAuth()` returns whatever account *routing*
   * picked, which can be a pooled one, so figures labelled as the primary
   * account could silently belong to another.
   */
  readCredential?: CredentialReader;
}

/** Fallback when pi's reader was not supplied: the same file pi reads. */
function readAuthFile(providerId: string): unknown {
  return readJson<Record<string, unknown>>(agentPath("auth.json"), {})[providerId];
}

interface StoredOAuth {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

function usableOAuth(value: unknown, now = Date.now()): value is StoredOAuth {
  const credential = value as Partial<StoredOAuth> | undefined;
  return credential?.type === "oauth"
    && typeof credential.access === "string" && credential.access.length > 0
    && (typeof credential.expires !== "number" || credential.expires > now + 60_000);
}

/**
 * The provider's primary OAuth credential, or undefined when pi holds none
 * (not logged in, or an API key, which has no subscription quota).
 *
 * An expiring credential is refreshed by pi itself (`getProviderAuth`
 * refreshes and persists before it routes) and then read back, so rotating
 * refresh tokens are only ever spent by pi.
 */
async function primaryOAuth(ctx: any, providerId: string, read: CredentialReader): Promise<StoredOAuth | undefined> {
  const stored = read(providerId) as { type?: unknown } | undefined;
  if (stored?.type !== "oauth") return undefined;
  if (usableOAuth(stored)) return stored;

  await ctx?.modelRegistry?.getProviderAuth?.(providerId);
  const refreshed = read(providerId);
  if (usableOAuth(refreshed)) return refreshed;
  throw new Error(`login expired, run /login ${providerId}`);
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

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


/**
 * Builds usage rows from a stored quota snapshot.
 *
 * Snapshots are refreshed for free from response headers on every request, so
 * serving the HUD from them avoids touching `/api/oauth/usage` at all. That
 * endpoint rate limits aggressively, and /usage polling several accounts was a
 * reliable way to get 429s and then show nothing.
 *
 * Returns undefined when there is no snapshot yet, so the caller can fetch.
 */
function rowsFromSnapshot(group: string, quota: any): UsageRow[] | undefined {
  if (!quota) return undefined;
  const rows: UsageRow[] = [];
  const push = (label: string, window: any) => {
    if (typeof window?.remainingPercent !== "number") return;
    rows.push({
      group,
      label,
      remaining: window.remainingPercent,
      resetAt: resetToMs(window.resetsAt),
      // Required: pool.isFresh discards any row without it, which would make
      // every cached row pool as "n/a".
      checkedAt: window.checkedAt ?? quota.checkedAt,
      capacity: window.capacity,
      stale: Date.now() - (window.checkedAt ?? quota.checkedAt ?? 0) >= CLAUDE_FRESH_MS,
    });
  };
  push("5h", quota.five_hour);
  push("7d", quota.seven_day);
  push("Extra", quota.extra);
  for (const scoped of Array.isArray(quota.scoped) ? quota.scoped : []) {
    if (typeof scoped?.remainingPercent !== "number" || typeof scoped?.id !== "string" || !scoped.id) continue;
    // Snapshots written before the fix restate the 5h/7d windows as "scoped".
    if (scoped.id === "scoped") continue;
    push(`7d ${scoped.id.toLowerCase()}`, scoped);
  }
  return rows.length ? rows : undefined;
}

const claudeGroup = (account: AnthropicAccount) => `Claude ${account.label ?? account.id.slice(0, 8)}`;

export async function fetchClaudeRows(
  ctx: any,
  options: SourceOptions = {},
): Promise<{ rows: UsageRow[]; errors: string[]; groups: string[] }> {
  const read = options.readCredential ?? readAuthFile;
  const rows: UsageRow[] = [];
  const errors: string[] = [];
  const accounts: Array<{ group: string; token?: string; identity?: string; account?: AnthropicAccount }> = [];
  const groups = new Set<string>();

  let sidecars: AnthropicAccount[] = [];
  try {
    sidecars = (loadAccounts()?.accounts ?? []).filter((account) => account.type === "oauth" && account.enabled !== false);
  } catch (error) {
    errors.push(`Claude accounts: ${errorText(error)}`);
  }
  const taken = new Set(sidecars.map(claudeGroup));
  const primaryGroup = taken.has("Claude Personal") ? "Claude Primary" : "Claude Personal";

  try {
    const primary = await primaryOAuth(ctx, "anthropic", read);
    if (!primary) {
      errors.push(`${primaryGroup}: not logged in`);
    } else {
      // pi's own login is often the same Claude account as a pooled one.
      // Counting it twice filed every window twice and marked the pool partial.
      const identity = cachedAnthropicAccountIdentity(primary.access)
        ?? await anthropicAccountIdentity(primary.access).catch(() => undefined);
      const twin = sidecars.find((account) => account.access === primary.access || (identity && account.identity === identity));
      if (!twin) {
        accounts.push({ group: primaryGroup, token: primary.access, identity });
        groups.add(primaryGroup);
      }
    }
  } catch (error) {
    // Logged in but unreadable: still an account the pool expects.
    groups.add(primaryGroup);
    errors.push(`${primaryGroup}: ${errorText(error)}`);
  }

  const seen = new Set<string>();
  for (const account of sidecars) {
    const key = account.identity ?? account.access ?? account.id;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ group: claudeGroup(account), account });
    groups.add(claudeGroup(account));
  }

  for (const entry of accounts) {
    try {
      const token = entry.token ?? (entry.account ? await ensureAccessToken(entry.account) : undefined);
      if (!token) {
        errors.push(`${entry.group}: no token`);
        continue;
      }
      const result = await readClaudeQuota({
        access: token, identity: entry.identity ?? entry.account?.identity,
        id: entry.account?.id, quota: entry.account?.quota,
      });
      rows.push(...(rowsFromSnapshot(entry.group, result.quota) ?? []));
      if (result.error) errors.push(`${entry.group}: ${result.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(/invalid_grant/i.test(message)
        ? `${entry.group}: login expired, run /accounts reauth ${entry.account?.label ?? entry.account?.id ?? ""}`.trim()
        : `${entry.group}: ${message}`);
    }
  }

  return { rows, errors, groups: [...groups] };
}

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
): Promise<{ rows: UsageRow[]; error?: string; plan?: string }> {
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

const GEMINI = "gemini";
const GEMINI_PRIMARY_GROUP = "Gemini Primary";

/** A pooled Gemini account with a live token, refreshed and saved if it had lapsed. */
async function freshGeminiAccount(account: PooledOAuthAccount): Promise<PooledOAuthAccount> {
  if (account.expires > Date.now() + 60_000) return account;
  // Google does not rotate refresh tokens on use, so a refresh racing the
  // serving path's own is harmless: both tokens stay valid.
  const credential = await geminiOAuth.refresh(account, refreshAbortSignal());
  const updated = { ...account, ...credential };
  saveOAuthAccount(GEMINI, updated);
  return updated;
}

/**
 * Gemini quota per account from `retrieveUserQuota`, one row per model
 * family (Flash, Pro, Claude, GPT). Silent when no Gemini account exists.
 */
export async function fetchGeminiRows(
  ctx: any,
  options: SourceOptions = {},
): Promise<{ rows: UsageRow[]; errors: string[]; groups: string[] }> {
  const errors: string[] = [];
  const accounts: Array<{ group: string; credential?: StoredOAuth; account?: PooledOAuthAccount }> = [];
  const groups: string[] = [];
  const emails = new Set<string>();

  try {
    const primary = await primaryOAuth(ctx, GEMINI, options.readCredential ?? readAuthFile);
    if (primary) {
      accounts.push({ group: GEMINI_PRIMARY_GROUP, credential: primary });
      const email = credentialEmail(primary as any);
      if (email) emails.add(email.toLowerCase());
    }
  } catch (error) {
    groups.push(GEMINI_PRIMARY_GROUP);
    errors.push(`${GEMINI_PRIMARY_GROUP}: ${errorText(error)}`);
  }

  try {
    for (const account of loadOAuthPool(GEMINI).accounts) {
      if (account.enabled === false || !account.access) continue;
      // The same Google account signed in twice has one allowance, not two.
      const email = credentialEmail(account)?.toLowerCase();
      if (email && emails.has(email)) continue;
      if (email) emails.add(email);
      let group = `Gemini ${account.label || email || account.id.slice(0, 8)}`;
      if (accounts.some((entry) => entry.group === group)) group = `${group} ${account.id.slice(0, 4)}`;
      accounts.push({ group, account });
    }
  } catch (error) {
    errors.push(`Gemini accounts: ${errorText(error)}`);
  }

  const results = await Promise.all(accounts.map(async (entry): Promise<{ rows: UsageRow[]; error?: string }> => {
    try {
      const credential = entry.account ? await freshGeminiAccount(entry.account) : entry.credential!;
      const buckets = await fetchUserQuota(
        credential.access,
        requestProjectId(credential as any),
        AbortSignal.timeout(TIMEOUT_MS),
      );
      const checkedAt = Date.now();
      const rows = summarizeGeminiQuota(buckets).map((family): UsageRow => ({
        group: entry.group,
        label: family.family,
        remaining: family.remaining,
        resetAt: family.resetAt,
        checkedAt,
      }));
      return rows.length ? { rows } : { rows, error: `${entry.group}: quota unavailable` };
    } catch (error) {
      const message = errorText(error);
      const reauth = entry.account ? `/accounts reauth gemini ${entry.account.label || entry.account.id}` : "/login gemini";
      return {
        rows: [],
        error: error instanceof GeminiVerificationRequiredError
          ? `${entry.group}: Google account verification required; run ${reauth} to complete verification.`
          : /invalid_grant/i.test(message)
            ? `${entry.group}: login expired, run ${reauth}`
            : `${entry.group}: ${message}`,
      };
    }
  }));

  return {
    rows: results.flatMap((result) => result.rows),
    errors: [...errors, ...results.flatMap((result) => result.error ?? [])],
    groups: [...groups, ...accounts.map((entry) => entry.group)],
  };
}

function observedRemaining(quota: AccountQuotaState, now: number): number | undefined {
  // A 429 reading means nothing once its block has cleared.
  if (quota.blockedUntil !== undefined) return quota.blockedUntil > now ? 0 : undefined;
  return quota.remainingPercent;
}

/**
 * What response headers last said for providers without a usage endpoint:
 * the account routing can still use most. A rate-limit reading, not a
 * subscription allowance, so it is labelled "rate" and dropped once old.
 */
export function observedRows(now = Date.now()): UsageRow[] {
  return OBSERVED_PROVIDERS.flatMap(([providerId, group]): UsageRow[] => {
    let quotas: AccountQuotaState[] = [];
    try {
      const store = sharedOAuthPoolStore(providerId);
      quotas = [
        store.primaryQuota(),
        ...store.load().accounts.filter((account) => account.enabled !== false).map((account) => account.quota),
      ].filter((quota): quota is AccountQuotaState => !!quota);
    } catch {
      return [];
    }

    const current = quotas.filter((quota) => observedRemaining(quota, now) !== undefined
      && ((quota.blockedUntil ?? 0) > now || now - quota.checkedAt < CLAUDE_FRESH_MS));
    if (current.length === 0) return [];
    const best = current.reduce((left, right) =>
      observedRemaining(right, now)! > observedRemaining(left, now)! ? right : left);
    const blocked = (best.blockedUntil ?? 0) > now;
    return [{
      group,
      label: "rate",
      remaining: observedRemaining(best, now)!,
      resetAt: blocked ? best.blockedUntil : best.resetAt,
      // A live block stays current until it clears, however old the reading.
      checkedAt: blocked ? now : best.checkedAt,
    }];
  });
}

/** One full poll of every configured subscription source. */
export async function fetchAll(ctx: any, options: SourceOptions = {}): Promise<SourceResult> {
  const [claude, codex, gemini] = await Promise.all([
    fetchClaudeRows(ctx, options),
    fetchCodexRows(ctx, options),
    fetchGeminiRows(ctx, options),
  ]);
  return {
    rows: [...claude.rows, ...codex.rows, ...gemini.rows, ...observedRows()],
    errors: [...claude.errors, codex.error, ...gemini.errors].filter((error): error is string => !!error),
    groups: claude.groups,
    geminiGroups: gemini.groups,
    codexPlan: codex.plan,
  };
}
