import { randomUUID } from "node:crypto";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "../../../core/accounts/registry.ts";
import { anthropicAccountIdentity } from "../../../core/anthropic/identity.ts";
import { authorize, exchange } from "../../../core/anthropic/oauth.ts";
import { ensureAccessToken } from "../../../core/anthropic/quota.ts";
import {
  getRoutingMode,
  loadAccounts,
  saveAccount,
  setRoutingMode,
  type Account,
} from "../../../core/anthropic/store.ts";

/**
 * Anthropic adapter.
 *
 * pi itself holds one Anthropic credential; the additional accounts live in
 * our own store and tokens are swapped per request. Everything
 * provider-specific lives here so `/accounts` and `/routing` stay generic.
 *
 * This used to read through `vendor/anthropic.ts`, which loaded the cortexkit
 * package. That package was removed when the provider was extracted, so every
 * call here threw and the account list silently came back empty. It now uses
 * the extracted store directly.
 */

async function authenticate(ctx: AccountContext): Promise<{ access: string; refresh: string; expires: number } | undefined> {
  const auth = await authorize("max");

  try {
    await ctx.openBrowser(auth.url);
  } catch {
    ctx.ui.notify(`Open this authorization URL:\n${auth.url}`, "warning");
  }

  const callback = await ctx.ui.input("Claude OAuth", "Paste the callback URL or authorization code");
  if (!callback) return undefined;

  const result = await exchange(callback, auth.verifier, auth.redirectUri, auth.state);
  if (result.type !== "success") {
    throw new Error(`Claude OAuth exchange failed: ${result.reason}`);
  }
  return { access: result.access, refresh: result.refresh, expires: result.expires };
}

/** Resolves and persists identity once; token rotation does not change it. */
async function stableIdentity(account: Account): Promise<string | undefined> {
  if (account.identity) return account.identity;
  let access = account.access;
  if (!access || (typeof account.expires === "number" && account.expires <= Date.now())) {
    try { access = await ensureAccessToken(account); } catch { return undefined; }
  }
  if (!access) return undefined;
  const identity = await anthropicAccountIdentity(access);
  if (!identity) return undefined;

  const current = loadAccounts()?.accounts.find((candidate) => candidate.id === account.id);
  if (current && !current.identity) saveAccount({ ...current, identity });
  return identity;
}

export const anthropicAccounts: AccountProvider = {
  id: "anthropic",
  label: "Claude",

  async list(): Promise<ManagedAccount[]> {
    const accounts = (loadAccounts()?.accounts ?? []).filter((account) => account.type === "oauth");
    const result: ManagedAccount[] = [];
    // Bootstrap is deliberately serial: this is a one-time migration for old
    // rows, and concurrent profile requests can be throttled independently.
    for (const account of accounts) {
      result.push({
        id: account.id,
        label: account.label ?? account.id.slice(0, 8),
        enabled: account.enabled !== false,
        expiresAt: typeof account.expires === "number" ? account.expires : undefined,
        identity: await stableIdentity(account),
      });
    }
    return result;
  },

  identify: anthropicAccountIdentity,

  async add(ctx, label): Promise<string | undefined> {
    const proceed = await ctx.ui.confirm(
      "Add Claude account",
      "Use a different authorized Anthropic account in the browser. Continue?",
    );
    if (!proceed) return undefined;

    const result = await authenticate(ctx);
    if (!result) return undefined;

    const now = Date.now();
    const identity = await anthropicAccountIdentity(result.access);
    saveAccount({
      id: randomUUID(),
      label,
      type: "oauth",
      enabled: true,
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
      addedAt: now,
      lastRefreshedAt: now,
      identity,
      authLineageId: randomUUID(),
    });
    return label;
  },

  async reauth(ctx, accountId): Promise<string | undefined> {
    const storage = loadAccounts();
    const account = storage?.accounts.find(
      (candidate) => candidate.id === accountId || candidate.label === accountId,
    );
    if (!account || account.type !== "oauth") {
      throw new Error(`OAuth account “${accountId}” not found.`);
    }

    const result = await authenticate(ctx);
    if (!result) return undefined;

    const identity = await anthropicAccountIdentity(result.access);
    saveAccount({
      ...account,
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
      lastRefreshedAt: Date.now(),
      lastRefreshError: undefined,
      identity,
      quota: undefined,
      authLineageId: randomUUID(),
    });
    return account.label ?? account.id;
  },

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    const storage = loadAccounts();
    const account = storage?.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Account “${accountId}” not found.`);
    // Credentials are preserved; only the eligibility flag changes, so a
    // disabled account can be re-enabled without another OAuth round trip.
    saveAccount({ ...account, enabled });
  },

  async rename(accountId: string, label: string): Promise<void> {
    const account = loadAccounts()?.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Account “${accountId}” not found.`);
    saveAccount({ ...account, label });
  },

  routing: {
    async get(): Promise<RoutingMode> {
      return getRoutingMode(loadAccounts());
    },
    async set(mode: RoutingMode): Promise<RoutingMode> {
      setRoutingMode(mode);
      return mode;
    },
    describe(mode: RoutingMode): string {
      return mode === "quota-aware"
        ? "Uses the Claude subscription with the most remaining quota."
        : "Uses Claude subscriptions in order, moving on when one is exhausted.";
    },
  },
};
