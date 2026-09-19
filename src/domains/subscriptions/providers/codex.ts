import { randomUUID } from "node:crypto";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "../../../core/accounts/registry.ts";
import { authorizeCodex, exchangeCodex } from "../../../core/codex/oauth.ts";
import {
  claimsOf,
  loadCodexAccounts,
  saveCodexAccount,
  saveCodexAccounts,
  type CodexAccount,
} from "../../../core/codex/store.ts";

/**
 * Codex adapter.
 *
 * Structurally the same as the Anthropic one, with two differences that come
 * from the provider rather than from us:
 *   - quota arrives only through response headers, so there is no poll;
 *   - every request must carry the account's `chatgpt-account-id`, so the
 *     account id is stored alongside the tokens rather than derived later.
 */

async function authenticate(ctx: AccountContext) {
  const auth = await authorizeCodex();

  try {
    await ctx.openBrowser(auth.url);
  } catch {
    ctx.ui.notify(`Open this authorization URL:\n${auth.url}`, "warning");
  }

  const callback = await ctx.ui.input("Codex OAuth", "Paste the callback URL or authorization code");
  if (!callback) return undefined;

  return exchangeCodex(callback, auth.verifier, auth.redirectUri, auth.state);
}

function describePlan(account: CodexAccount): string {
  return account.plan ? `${account.label ?? account.id.slice(0, 8)} (${account.plan})` : (account.label ?? account.id.slice(0, 8));
}

export const codexAccounts: AccountProvider = {
  id: "openai-codex",
  label: "Codex",

  async list(): Promise<ManagedAccount[]> {
    return loadCodexAccounts().accounts.map((account) => ({
      id: account.id,
      label: describePlan(account),
      enabled: account.enabled !== false,
      expiresAt: typeof account.expires === "number" ? account.expires : undefined,
    }));
  },

  async add(ctx, label): Promise<string | undefined> {
    const proceed = await ctx.ui.confirm(
      "Add Codex account",
      "Sign in with a DIFFERENT ChatGPT account in the browser. Continue?",
    );
    if (!proceed) return undefined;

    const tokens = await authenticate(ctx);
    if (!tokens) return undefined;

    const claims = claimsOf(tokens.access);

    // Adding the same ChatGPT account twice gives routing two entries backed by
    // one quota pool, which looks like capacity that does not exist.
    const existing = loadCodexAccounts().accounts.find(
      (a) => claims.accountId && a.accountId === claims.accountId,
    );
    if (existing) {
      throw new Error(
        `That ChatGPT account is already added as “${existing.label ?? existing.id.slice(0, 8)}”. `
        + "Use the browser's account switcher to sign in as a different account.",
      );
    }

    const now = Date.now();
    saveCodexAccount({
      id: randomUUID(),
      label,
      enabled: true,
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId: claims.accountId,
      plan: claims.plan,
      addedAt: now,
      lastRefreshedAt: now,
    });
    return label;
  },

  async reauth(ctx, accountId): Promise<string | undefined> {
    const account = loadCodexAccounts().accounts.find(
      (a) => a.id === accountId || a.label === accountId,
    );
    if (!account) throw new Error(`Codex account “${accountId}” not found.`);

    const tokens = await authenticate(ctx);
    if (!tokens) return undefined;

    const claims = claimsOf(tokens.access);
    saveCodexAccount({
      ...account,
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId: claims.accountId ?? account.accountId,
      plan: claims.plan ?? account.plan,
      lastRefreshedAt: Date.now(),
    });
    return account.label ?? account.id;
  },

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    const storage = loadCodexAccounts();
    const account = storage.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Account “${accountId}” not found.`);
    account.enabled = enabled;
    saveCodexAccounts(storage);
  },

  async rename(accountId: string, label: string): Promise<void> {
    const storage = loadCodexAccounts();
    const account = storage.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Account “${accountId}” not found.`);
    account.label = label;
    saveCodexAccounts(storage);
  },

  routing: {
    async get(): Promise<RoutingMode> {
      return loadCodexAccounts().routing?.mode === "optimal" ? "optimal" : "standard";
    },
    async set(mode: RoutingMode): Promise<RoutingMode> {
      const storage = loadCodexAccounts();
      storage.routing = { ...(storage.routing ?? {}), mode };
      saveCodexAccounts(storage);
      return mode;
    },
    describe(mode: RoutingMode): string {
      return mode === "optimal"
        ? "Balances across Codex subscriptions using remaining quota and time until reset."
        : "Main Codex subscription first, then eligible fallbacks.";
    },
  },
};
