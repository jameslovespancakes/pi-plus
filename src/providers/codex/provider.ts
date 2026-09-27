import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accountRetryAt } from "../shared/accounts/provider-errors.ts";
import type { RoutingMode } from "../shared/accounts/registry.ts";
import { normalizeRoutingMode, quotaStateFromWindows, type AccountQuotaState } from "../shared/accounts/routing.ts";
import type { PooledOAuthAccount, PooledOAuthStore } from "../shared/accounts/oauth-pool.ts";
import { applyCodexQuotaHeaders } from "./quota.ts";
import { codexFailureReason } from "./errors.ts";
import { recoveryReason } from "../shared/accounts/request-recovery.ts";
import {
  MAIN_ACCOUNT_ID,
  claimsOf,
  loadCodexAccounts,
  saveCodexAccount,
  saveCodexAccounts,
  type CodexAccount,
} from "./store.ts";
import { fetchCodexRows } from "./usage.ts";
import { builtinProvider } from "../shared/builtin.ts";
import {
  chooseCredential,
  createPooledOAuthAdapter,
  registerPooledOAuthProvider,
  type PooledOAuthProviderSpec,
} from "../shared/serving.ts";

/**
 * Codex adapter.
 *
 * Codex shares the pooled serving path with every other subscription provider
 * (request-level routing, bounded refresh, and per-attempt telemetry). Only the two
 * genuinely provider-specific pieces are supplied here:
 *
 *   - storage stays in `codex-accounts.json`, because it carries `accountId`
 *     (which the usage bars read) and a rich quota snapshot that the generic
 *     pool schema has no room for;
 *   - quota comes from `x-codex-*` headers first; a headerless limit can
 *     recheck the same credential through the existing non-inference usage endpoint.
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
function quotaState(quota: CodexAccount["quota"], blockedUntil?: number, modelId?: string): AccountQuotaState | undefined {
  const blocked = blockedUntil && blockedUntil > Date.now() ? blockedUntil : undefined;
  if (!quota) {
    return blocked ? { remainingPercent: 0, checkedAt: Date.now(), blockedUntil: blocked } : undefined;
  }
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const scoped = (quota.scoped ?? []).filter((window) => !modelId || !window.id || normalized(modelId).includes(normalized(window.id)));
  const windows = [quota.five_hour, quota.seven_day, ...scoped]
    .filter((window) => window && Number.isFinite(window.remainingPercent));
  if (windows.length === 0) {
    return blocked ? { remainingPercent: 0, checkedAt: quota.checkedAt ?? Date.now(), blockedUntil: blocked } : undefined;
  }

  const state = quotaStateFromWindows(windows.map((window) => {
    const at = Date.parse(window!.resetsAt ?? "");
    return { remainingPercent: window!.remainingPercent, resetAt: Number.isFinite(at) ? at : undefined };
  }), quota.checkedAt ?? Date.now());
  return blocked ? { ...state, checkedAt: state?.checkedAt ?? Date.now(), blockedUntil: blocked } : state;
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
  const blockedUntil = accountRetryAt(headers);
  const storage = loadCodexAccounts();
  if (accountId === MAIN_ACCOUNT_ID) {
    storage.main = { ...storage.main, blockedUntil: Math.max(storage.main?.blockedUntil ?? 0, blockedUntil) };
    saveCodexAccounts(storage);
    return;
  }
  const account = storage.accounts.find((candidate) => candidate.id === accountId);
  if (account) saveCodexAccount({ ...account, blockedUntil: Math.max(account.blockedUntil ?? 0, blockedUntil) });
}

export const CODEX_SPEC: PooledOAuthProviderSpec<"openai-codex-responses"> = {
  id: "openai-codex",
  label: "Codex",
  createProvider: () => builtinProvider("openai-codex"),
  classifyFailure: (message) => recoveryReason(message) ?? codexFailureReason(message),
  store: CODEX_STORE,
  addPrompt: "Sign in with a DIFFERENT ChatGPT account in the browser. Continue?",
  describeAccount: (account) => describePlan(account as PooledOAuthAccount & CodexAccount),
  // Two entries backed by one ChatGPT account would look like capacity that
  // does not exist, so duplicates are matched on the token's account claim.
  identityOf: (access) => claimsOf(access).accountId,
  quotaFor(credential, modelId, accountId) {
    const storage = loadCodexAccounts();
    const account = accountId === MAIN_ACCOUNT_ID ? storage.main : storage.accounts.find((entry) => entry.id === accountId);
    const duplicate = storage.accounts.find((entry) => entry.access === credential.access);
    return quotaState(account?.quota ?? duplicate?.quota, Math.max(account?.blockedUntil ?? 0, duplicate?.blockedUntil ?? 0), modelId);
  },
  async checkQuota(accountId, credential, modelId, signal) {
    const startedAt = Date.now();
    const before = loadCodexAccounts();
    const cached = accountId === MAIN_ACCOUNT_ID ? before.main : before.accounts.find((entry) => entry.id === accountId);
    const known = quotaState(cached?.quota, undefined, modelId);
    if (cached?.quota?.source === "headers" && (cached.quota.checkedAt ?? 0) >= startedAt - 5_000
      && ((known?.remainingPercent ?? 0) > 0 || known?.resetAt !== undefined)) return;
    const result = await fetchCodexRows(undefined, { readCredential: () => credential, signal });
    if (result.quota) {
      const storage = loadCodexAccounts();
      const latest = accountId === MAIN_ACCOUNT_ID ? storage.main : storage.accounts.find((entry) => entry.id === accountId);
      if ((latest?.quota?.checkedAt ?? 0) > startedAt) return;
      if (accountId === MAIN_ACCOUNT_ID) {
        storage.main = { ...storage.main, quota: result.quota };
        saveCodexAccounts(storage);
      } else {
        const account = storage.accounts.find((entry) => entry.id === accountId);
        if (account?.access === credential.access) saveCodexAccount({ ...account, quota: result.quota, plan: result.plan ?? account.plan });
      }
    }
    return result.retryAt;
  },
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
