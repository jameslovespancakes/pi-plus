import { randomUUID } from "node:crypto";
import type { ModelAuth, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "../../../core/accounts/registry.ts";
import { normalizeRoutingMode, selectRoutingCandidate, type AccountQuotaState } from "../../../core/accounts/routing.ts";
import { authorizeCodex, exchangeCodex } from "../../../core/codex/oauth.ts";
import { applyCodexQuotaHeaders } from "../../../core/codex/quota.ts";
import {
  MAIN_ACCOUNT_ID,
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

type RoutableCodexAccount = CodexAccount & { access: string; refresh: string; expires: number };

const refreshes = new Map<string, Promise<RoutableCodexAccount>>();
const codexLastUsed = new Map<string, number>();

function isRoutableCodexAccount(account: CodexAccount): account is RoutableCodexAccount {
  return account.enabled !== false
    && typeof account.access === "string"
    && typeof account.refresh === "string"
    && typeof account.expires === "number";
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
      return codexRoutingMode(loadCodexAccounts().routing?.mode);
    },
    async set(mode: RoutingMode): Promise<RoutingMode> {
      const storage = loadCodexAccounts();
      storage.routing = { ...(storage.routing ?? {}), mode };
      saveCodexAccounts(storage);
      return mode;
    },
    describe(mode: RoutingMode): string {
      return mode === "quota-aware"
        ? "Uses the Codex subscription with the most remaining quota."
        : "Uses Codex subscriptions in order, moving on when one is exhausted.";
    },
  },
};

export function codexRoutingMode(value: string | undefined): RoutingMode {
  return normalizeRoutingMode(value);
}

function quotaState(quota: CodexAccount["quota"], blockedUntil?: number): AccountQuotaState | undefined {
  if (!quota) {
    return blockedUntil && blockedUntil > Date.now()
      ? { remainingPercent: 0, checkedAt: Date.now(), blockedUntil }
      : undefined;
  }
  const windows = [quota.five_hour, quota.seven_day, ...(quota.scoped ?? [])]
    .filter((window) => window && Number.isFinite(window.remainingPercent));
  if (windows.length === 0) return undefined;

  const remainingPercent = Math.min(...windows.map((window) => window!.remainingPercent!));
  const resetTimes = windows
    .filter((window) => (window!.remainingPercent ?? 0) <= 0 && window!.resetsAt)
    .map((window) => Date.parse(window!.resetsAt!))
    .filter(Number.isFinite);
  const resetAt = resetTimes.length > 0 ? Math.min(...resetTimes) : undefined;
  return {
    remainingPercent: blockedUntil && blockedUntil > Date.now() ? 0 : remainingPercent,
    resetAt,
    checkedAt: quota.checkedAt ?? Date.now(),
    blockedUntil: blockedUntil && blockedUntil > Date.now()
      ? blockedUntil
      : remainingPercent <= 0 ? resetAt ?? Number.POSITIVE_INFINITY : undefined,
  };
}

export function chooseCodexCredential(primary: OAuthCredential): {
  readonly id: string;
  readonly credential: OAuthCredential;
  readonly account?: RoutableCodexAccount;
} {
  const storage = loadCodexAccounts();
  const mode = codexRoutingMode(storage.routing?.mode);
  const candidates = [
    {
      id: MAIN_ACCOUNT_ID,
      order: 0,
      lastUsed: codexLastUsed.get(MAIN_ACCOUNT_ID) ?? storage.main?.lastUsed ?? 0,
      quota: quotaState(storage.main?.quota, storage.main?.blockedUntil),
      value: { id: MAIN_ACCOUNT_ID, credential: primary },
    },
    ...storage.accounts
      .filter(isRoutableCodexAccount)
      .map((account, index) => ({
        id: account.id,
        order: index + 1,
        lastUsed: codexLastUsed.get(account.id) ?? account.lastUsed ?? 0,
        quota: quotaState(account.quota, account.blockedUntil),
        value: {
          id: account.id,
          credential: { ...account, type: "oauth" as const } satisfies OAuthCredential,
          account,
        },
      })),
  ];
  return selectRoutingCandidate(candidates, mode)?.value ?? { id: MAIN_ACCOUNT_ID, credential: primary };
}

async function freshCodexAccount(
  oauth: OAuthAuth,
  account: RoutableCodexAccount,
  signal: AbortSignal,
): Promise<RoutableCodexAccount> {
  if (account.access && account.expires && account.expires > Date.now() + 60_000) return account;
  const active = refreshes.get(account.id);
  if (active) return active;

  const credential: OAuthCredential = { ...account, type: "oauth" };
  const refresh = oauth.refresh(credential, signal).then((updated) => {
    const next: RoutableCodexAccount = { ...account, ...updated };
    saveCodexAccount(next);
    return next;
  }).finally(() => refreshes.delete(account.id));
  refreshes.set(account.id, refresh);
  return refresh;
}

async function routedCodexAuth(
  oauth: OAuthAuth,
  primary: OAuthCredential,
): Promise<ModelAuth> {
  const selected = chooseCodexCredential(primary);
  const account = selected.account
    ? await freshCodexAccount(oauth, selected.account, new AbortController().signal)
    : undefined;
  const credential: OAuthCredential = account ? { ...account, type: "oauth" } : primary;
  const now = Date.now();
  codexLastUsed.set(selected.id, now);
  const storage = loadCodexAccounts();
  if (selected.id === MAIN_ACCOUNT_ID) {
    if (now - (storage.main?.lastUsed ?? 0) >= 60_000) {
      storage.main = { ...storage.main, lastUsed: now };
      saveCodexAccounts(storage);
    }
  } else if (account && now - (account.lastUsed ?? 0) >= 60_000) {
    saveCodexAccount({ ...account, lastUsed: now });
  }
  return oauth.toAuth(credential);
}

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

export function registerCodexProvider(pi: ExtensionAPI): void {
  const provider = openaiCodexProvider();
  const oauth = provider.auth.oauth;
  if (!oauth) return;

  const withQuotaObserver = (options: any) => ({
    ...options,
    onResponse: async (response: { status: number; headers: Record<string, string> }, model: unknown) => {
      const storage = loadCodexAccounts();
      const account = storage.accounts.find((candidate) => candidate.access === options?.apiKey);
      const accountId = account?.id ?? MAIN_ACCOUNT_ID;
      applyCodexQuotaHeaders(accountId, response.headers);
      if (response.status === 429) markCodexRateLimited(accountId, response.headers);
      await options?.onResponse?.(response, model);
    },
  });

  pi.registerProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        toAuth: (primary) => routedCodexAuth(oauth, primary),
      },
    },
    stream: (model: any, context: any, options: any) => provider.stream(model, context, withQuotaObserver(options)),
    streamSimple: (model: any, context: any, options: any) => provider.streamSimple(model, context, withQuotaObserver(options)),
  });
}
