import type { OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RoutingMode } from "../../../core/accounts/registry.ts";
import { normalizeRoutingMode, type AccountQuotaState } from "../../../core/accounts/routing.ts";
import type { PooledOAuthAccount, PooledOAuthStore } from "../../../core/accounts/oauth-pool.ts";
import { applyCodexQuotaHeaders } from "../../../core/codex/quota.ts";
import {
  MAIN_ACCOUNT_ID,
  claimsOf,
  loadCodexAccounts,
  saveCodexAccount,
  saveCodexAccounts,
  type CodexAccount,
} from "../../../core/codex/store.ts";
import {
  chooseCredential,
  createPooledOAuthAdapter,
  registerPooledOAuthProvider,
  type PooledOAuthProviderSpec,
} from "./oauth-pool.ts";

/**
 * Codex adapter.
 *
 * Codex shares the pooled serving path with every other subscription provider
 * (one `routedAuth`, one bounded refresh, one quota observer). Only the two
 * genuinely provider-specific pieces are supplied here:
 *
 *   - storage stays in `codex-accounts.json`, because it carries `accountId`
 *     (which the usage bars read) and a rich quota snapshot that the generic
 *     pool schema has no room for;
 *   - quota arrives through `x-codex-*` response headers rather than the
 *     generic `x-ratelimit-*` set, so there is no polling path at all.
 *
 * The ChatGPT account id does NOT need to be threaded through auth: the
 * provider derives it from the access token's JWT claims and sets the
 * `chatgpt-account-id` header itself, so swapping the token is self-consistent.
 */

function describePlan(account: CodexAccount): string {
  const name = account.label ?? account.id.slice(0, 8);
  return account.plan ? `${name} (${account.plan})` : name;
}

/** Routing view of a stored Codex snapshot. */
function quotaState(quota: CodexAccount["quota"], blockedUntil?: number): AccountQuotaState | undefined {
  const blocked = blockedUntil && blockedUntil > Date.now() ? blockedUntil : undefined;
  if (!quota) {
    return blocked ? { remainingPercent: 0, checkedAt: Date.now(), blockedUntil: blocked } : undefined;
  }
  const windows = [quota.five_hour, quota.seven_day, ...(quota.scoped ?? [])]
    .filter((window) => window && Number.isFinite(window.remainingPercent));
  if (windows.length === 0) {
    return blocked ? { remainingPercent: 0, checkedAt: quota.checkedAt ?? Date.now(), blockedUntil: blocked } : undefined;
  }

  const remainingPercent = Math.min(...windows.map((window) => window!.remainingPercent!));
  const resetTimes = windows
    .filter((window) => (window!.remainingPercent ?? 0) <= 0 && window!.resetsAt)
    .map((window) => Date.parse(window!.resetsAt!))
    .filter(Number.isFinite);
  const resetAt = resetTimes.length > 0 ? Math.min(...resetTimes) : undefined;
  return {
    remainingPercent: blocked ? 0 : remainingPercent,
    resetAt,
    checkedAt: quota.checkedAt ?? Date.now(),
    // An exhausted window with no reset time is already non-viable, so there is
    // no sentinel here: `Infinity` would serialize to null and silently unblock.
    blockedUntil: blocked ?? (remainingPercent <= 0 ? resetAt : undefined),
  };
}

/** True when the account has a complete credential and can serve a request. */
function isRoutable(account: CodexAccount): boolean {
  return typeof account.access === "string"
    && typeof account.refresh === "string"
    && typeof account.expires === "number";
}

/**
 * Adapts `codex-accounts.json` to the pooled store contract.
 *
 * `quota` and `identity` are derived views, so they are never written back:
 * the pool would otherwise overwrite the rich snapshot the usage bars read
 * with the flattened routing state.
 */
const CODEX_STORE: PooledOAuthStore = {
  load() {
    const storage = loadCodexAccounts();
    return {
      mode: normalizeRoutingMode(storage.routing?.mode),
      accounts: storage.accounts.map((account) => ({
        ...account,
        type: "oauth" as const,
        // Blanking access on an incomplete credential keeps it out of routing
        // while still listing it under `/accounts`.
        access: isRoutable(account) ? account.access! : "",
        refresh: account.refresh ?? "",
        expires: account.expires ?? 0,
        label: account.label ?? "",
        identity: account.accountId,
        addedAt: account.addedAt ?? 0,
        quota: quotaState(account.quota, account.blockedUntil),
      })),
    };
  },

  saveAccount(account: PooledOAuthAccount) {
    const { quota: _quota, identity: _identity, type: _type, ...rest } = account as PooledOAuthAccount & CodexAccount;
    const claims = claimsOf(rest.access);
    saveCodexAccount({
      ...rest,
      accountId: rest.accountId ?? claims.accountId,
      plan: rest.plan ?? claims.plan,
    });
  },

  saveMode(mode) {
    const storage = loadCodexAccounts();
    storage.routing = { ...(storage.routing ?? {}), mode };
    saveCodexAccounts(storage);
  },

  primaryQuota() {
    const storage = loadCodexAccounts();
    return quotaState(storage.main?.quota, storage.main?.blockedUntil);
  },
};

/** Persists a rate-limit block so routing skips the account until it clears. */
function markCodexRateLimited(accountId: string, headers: Record<string, string>): void {
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const seconds = Number(raw);
  const blockedUntil = Date.now() + (Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 60_000);
  const storage = loadCodexAccounts();
  if (accountId === MAIN_ACCOUNT_ID) {
    storage.main = { ...storage.main, blockedUntil };
    saveCodexAccounts(storage);
    return;
  }
  const account = storage.accounts.find((candidate) => candidate.id === accountId);
  if (account) saveCodexAccount({ ...account, blockedUntil });
}

export const CODEX_SPEC: PooledOAuthProviderSpec = {
  id: "openai-codex",
  label: "Codex",
  createProvider: openaiCodexProvider,
  store: CODEX_STORE,
  addPrompt: "Sign in with a DIFFERENT ChatGPT account in the browser. Continue?",
  describeAccount: (account) => describePlan(account as PooledOAuthAccount & CodexAccount),
  // Two entries backed by one ChatGPT account would look like capacity that
  // does not exist, so duplicates are matched on the token's account claim.
  identityOf: (access) => claimsOf(access).accountId,
  recordQuota(accountId, status, headers) {
    // Never throws: swallows its own write failures.
    applyCodexQuotaHeaders(accountId, headers);
    if (status !== 429) return;
    try {
      markCodexRateLimited(accountId, headers);
    } catch {
      // Telemetry only — a failed block write must not fail the response.
    }
  },
};

export const codexAccounts = createPooledOAuthAdapter(CODEX_SPEC);

export function codexRoutingMode(value: string | undefined): RoutingMode {
  return normalizeRoutingMode(value);
}

/** Retained for callers and tests that select a Codex account directly. */
export function chooseCodexCredential(primary: OAuthCredential) {
  return chooseCredential(CODEX_SPEC, primary);
}

export function registerCodexProvider(pi: ExtensionAPI): void {
  registerPooledOAuthProvider(pi, CODEX_SPEC);
}
