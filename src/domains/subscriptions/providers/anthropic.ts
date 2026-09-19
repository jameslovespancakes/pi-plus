import { randomUUID } from "node:crypto";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "../../../core/accounts/registry.ts";
import { core, loadAccounts, routingMode, saveAccount, setRoutingMode } from "../../../vendor/anthropic.ts";

/**
 * Anthropic adapter, adopted from @cortexkit/anthropic-auth-core.
 *
 * pi itself holds one Anthropic credential; cortexkit keeps the additional
 * accounts in `anthropic-auth.json` and swaps tokens per request. Everything
 * provider-specific lives here so the `/account` and `/routing` commands stay
 * generic.
 */

/** Our vocabulary maps onto cortexkit's routing modes. */
const MODE_TO_VENDOR: Record<RoutingMode, string> = {
  standard: "main-first",
  optimal: "sticky-balanced",
};

function fromVendorMode(mode: string): RoutingMode {
  return mode === "sticky-balanced" ? "optimal" : "standard";
}

async function authenticate(ctx: AccountContext): Promise<{ access: string; refresh: string; expires: number } | undefined> {
  const { authorize, exchange } = await core();
  const auth = await authorize("max");

  try {
    await ctx.openBrowser(auth.url);
  } catch {
    ctx.ui.notify(`Open this authorization URL:\n${auth.url}`, "warning");
  }

  const callback = await ctx.ui.input("Claude OAuth", "Paste the callback URL or authorization code");
  if (!callback) return undefined;

  const result = await exchange(callback, auth.verifier, auth.redirectUri, auth.state);
  if (result.type !== "success") throw new Error("Claude OAuth exchange failed");
  return { access: result.access, refresh: result.refresh, expires: result.expires };
}

export const anthropicAccounts: AccountProvider = {
  id: "anthropic",
  label: "Claude",

  async list(): Promise<ManagedAccount[]> {
    const storage = await loadAccounts();
    return (storage?.accounts ?? [])
      .filter((account) => account.type === "oauth")
      .map((account) => ({
        id: account.id,
        label: account.label ?? account.id.slice(0, 8),
        enabled: account.enabled !== false,
        expiresAt: typeof account.expires === "number" ? account.expires : undefined,
      }));
  },

  async add(ctx, label): Promise<string | undefined> {
    const proceed = await ctx.ui.confirm(
      "Add Claude account",
      "Use a different authorized Anthropic account in the browser. Continue?",
    );
    if (!proceed) return undefined;

    const result = await authenticate(ctx);
    if (!result) return undefined;

    const now = Date.now();
    await saveAccount({
      id: randomUUID(),
      label,
      type: "oauth",
      enabled: true,
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
      addedAt: now,
      lastRefreshedAt: now,
      authLineageId: randomUUID(),
    });
    return label;
  },

  async reauth(ctx, accountId): Promise<string | undefined> {
    const storage = await loadAccounts();
    const account = storage?.accounts.find(
      (candidate) => candidate.id === accountId || candidate.label === accountId,
    );
    if (!account || account.type !== "oauth") {
      throw new Error(`OAuth account “${accountId}” not found.`);
    }

    const result = await authenticate(ctx);
    if (!result) return undefined;

    await saveAccount({
      ...account,
      access: result.access,
      refresh: result.refresh,
      expires: result.expires,
      lastRefreshedAt: Date.now(),
      authLineageId: randomUUID(),
    });
    return account.label ?? account.id;
  },

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    const storage = await loadAccounts();
    const account = storage?.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Account “${accountId}” not found.`);
    // Credentials are preserved; only the eligibility flag changes, so a
    // disabled account can be re-enabled without another OAuth round trip.
    await saveAccount({ ...account, enabled });
  },

  routing: {
    async get(): Promise<RoutingMode> {
      return fromVendorMode(await routingMode());
    },
    async set(mode: RoutingMode): Promise<RoutingMode> {
      return fromVendorMode(await setRoutingMode(MODE_TO_VENDOR[mode] as "sticky-balanced" | "main-first"));
    },
    describe(mode: RoutingMode): string {
      return mode === "optimal"
        ? "Balances sessions across subscriptions using remaining quota and time until reset. "
          + "Keeps session caches sticky; migrates on confirmed exhaustion."
        : "Main subscription first, then eligible fallbacks.";
    },
  },
};
