import { randomUUID } from "node:crypto";
import type { Api, ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "../../../core/accounts/registry.ts";
import {
  quotaStateFromHeaders,
  refreshAbortSignal,
  selectRoutingCandidate,
} from "../../../core/accounts/routing.ts";
import {
  oauthIdentity,
  setPrimaryQuota,
  sharedOAuthPoolStore,
  type PooledOAuthAccount,
  type PooledOAuthStore,
} from "../../../core/accounts/oauth-pool.ts";

export interface PooledOAuthProviderSpec<TApi extends Api> {
  id: string;
  label: string;
  createProvider(): Provider<TApi>;
  /** Backing storage. Defaults to the shared pi-plus OAuth pool file. */
  store?: PooledOAuthStore;
  /** Confirmation shown before an interactive `add`. */
  addPrompt?: string;
  /** Display label for an account. */
  describeAccount?(account: PooledOAuthAccount): string;
  /** Stable identity used to reject a duplicate login. Defaults to JWT claims. */
  identityOf?(access: string): string | undefined;
  /**
   * Records a response's quota signal against an account. Defaults to the
   * generic `x-ratelimit-*` reader; providers with their own headers (Codex
   * sends `x-codex-*`) override it. Must never throw: it runs inside the
   * awaited `onResponse`, so a rejection would kill an in-flight stream.
   */
  recordQuota?(accountId: string, status: number, headers: Record<string, string>): void;
}

const MAIN = "main";

const lastUsed = new Map<string, number>();
const refreshes = new Map<string, Promise<PooledOAuthAccount>>();

function storeFor<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>): PooledOAuthStore {
  return spec.store ?? sharedOAuthPoolStore(spec.id);
}

function oauthFor<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>): OAuthAuth {
  const oauth = spec.createProvider().auth.oauth;
  if (!oauth) throw new Error(`${spec.label} does not expose subscription OAuth.`);
  return oauth;
}

async function notifyAuthEvent(ctx: AccountContext, event: any): Promise<void> {
  if (event?.type === "device_code") {
    const url = String(event.verificationUri ?? "");
    if (url) await ctx.openBrowser(url).catch(() => undefined);
    ctx.ui.notify(`Enter code ${String(event.userCode ?? "")} at ${url}`, "info");
    return;
  }
  if (event?.type === "auth_url") {
    const url = String(event.url ?? "");
    if (url) await ctx.openBrowser(url).catch(() => undefined);
    ctx.ui.notify(event.instructions ? `${event.instructions}\n${url}` : url, "info");
    return;
  }
  if (typeof event?.message === "string") ctx.ui.notify(event.message, "info");
}

async function authenticate<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>, ctx: AccountContext): Promise<OAuthCredential> {
  const signal = ctx.signal ?? new AbortController().signal;
  return oauthFor(spec).login({
    signal,
    notify: (event) => { void notifyAuthEvent(ctx, event); },
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        const labels = prompt.options.map((option) => option.label);
        const selected = await ctx.ui.select(prompt.message, labels);
        const index = selected ? labels.indexOf(selected) : -1;
        if (index < 0) throw new Error("Login cancelled.");
        return prompt.options[index].id;
      }
      const value = await ctx.ui.input(prompt.message, prompt.placeholder);
      if (!value) throw new Error("Login cancelled.");
      return value;
    },
  });
}

function accountLabel<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>, account: PooledOAuthAccount): string {
  return spec.describeAccount?.(account) ?? (account.label || account.identity || account.id.slice(0, 8));
}

function identityFor<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>, access: string): string | undefined {
  return (spec.identityOf ?? oauthIdentity)(access);
}

function duplicateAccount<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  credential: OAuthCredential,
  excludeId?: string,
): PooledOAuthAccount | undefined {
  const identity = identityFor(spec, credential.access);
  return storeFor(spec).load().accounts.find((account) =>
    account.id !== excludeId && (identity ? account.identity === identity : account.access === credential.access));
}

export function createPooledOAuthAdapter<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>): AccountProvider {
  const store = () => storeFor(spec);

  return {
    id: spec.id,
    label: spec.label,

    async list(): Promise<ManagedAccount[]> {
      return store().load().accounts.map((account) => {
        const identity = account.identity ?? identityFor(spec, account.access);
        return {
          id: account.id,
          label: accountLabel(spec, account),
          enabled: account.enabled !== false,
          expiresAt: account.expires,
          ...(identity && { identity }),
        };
      });
    },

    identify: (accessToken) => identityFor(spec, accessToken),

    async add(ctx, label): Promise<string | undefined> {
      const prompt = spec.addPrompt ?? `Sign in with another ${spec.label} subscription?`;
      if (!await ctx.ui.confirm(`Add ${spec.label} account`, prompt)) return undefined;

      const credential = await authenticate(spec, ctx);
      const duplicate = duplicateAccount(spec, credential);
      if (duplicate) throw new Error(`That account is already saved as “${accountLabel(spec, duplicate)}”.`);

      store().saveAccount({
        ...credential,
        id: randomUUID(),
        label,
        enabled: true,
        identity: identityFor(spec, credential.access),
        addedAt: Date.now(),
      });
      return label;
    },

    async reauth(ctx, accountId): Promise<string | undefined> {
      const account = store().load().accounts.find(
        (candidate) => candidate.id === accountId || candidate.label === accountId,
      );
      if (!account) throw new Error(`${spec.label} account “${accountId}” not found.`);

      const credential = await authenticate(spec, ctx);
      const duplicate = duplicateAccount(spec, credential, account.id);
      if (duplicate) throw new Error(`That account is already saved as “${accountLabel(spec, duplicate)}”.`);
      store().saveAccount({
        ...account,
        ...credential,
        identity: identityFor(spec, credential.access),
      });
      return account.label;
    },

    async setEnabled(accountId, enabled): Promise<void> {
      const account = store().load().accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error(`${spec.label} account “${accountId}” not found.`);
      store().saveAccount({ ...account, enabled });
    },

    async rename(accountId, label): Promise<void> {
      const account = store().load().accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error(`${spec.label} account “${accountId}” not found.`);
      store().saveAccount({ ...account, label });
    },

    routing: {
      async get(): Promise<RoutingMode> {
        return store().load().mode;
      },
      async set(mode): Promise<RoutingMode> {
        store().saveMode(mode);
        return mode;
      },
      describe(mode): string {
        return mode === "quota-aware"
          ? `Uses the ${spec.label} subscription with the most remaining quota.`
          : `Uses ${spec.label} subscriptions in order, moving on when one is exhausted.`;
      },
    },
  };
}

export function chooseCredential<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  primary: OAuthCredential,
): { id: string; credential: OAuthCredential; account?: PooledOAuthAccount } {
  const pool = storeFor(spec).load();
  const candidates = [
    {
      id: MAIN,
      order: 0,
      lastUsed: lastUsed.get(`${spec.id}:${MAIN}`) ?? 0,
      quota: storeFor(spec).primaryQuota(),
      value: { id: MAIN, credential: primary },
    },
    ...pool.accounts
      .filter((account) => account.enabled !== false && account.access)
      .map((account, index) => ({
        id: account.id,
        order: index + 1,
        lastUsed: lastUsed.get(`${spec.id}:${account.id}`) ?? account.lastUsed ?? 0,
        quota: account.quota,
        value: { id: account.id, credential: account, account },
      })),
  ];
  return selectRoutingCandidate(candidates, pool.mode)?.value ?? { id: MAIN, credential: primary };
}

async function freshCredential<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  account: PooledOAuthAccount,
): Promise<PooledOAuthAccount> {
  if (account.expires > Date.now() + 60_000) return account;

  const key = `${spec.id}:${account.id}`;
  const active = refreshes.get(key);
  if (active) return active;

  // Bounded: nothing upstream constrains this call, and a hung refresh would be
  // shared by every later request for the account through the map above.
  const refresh = oauthFor(spec).refresh(account, refreshAbortSignal()).then((credential) => {
    const updated = { ...account, ...credential };
    storeFor(spec).saveAccount(updated);
    return updated;
  }).finally(() => refreshes.delete(key));
  refreshes.set(key, refresh);
  return refresh;
}

async function routedAuth<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  oauth: OAuthAuth,
  primary: OAuthCredential,
): Promise<ModelAuth> {
  const selected = chooseCredential(spec, primary);
  const credential = selected.account ? await freshCredential(spec, selected.account) : primary;
  const now = Date.now();
  lastUsed.set(`${spec.id}:${selected.id}`, now);

  if (selected.account && now - (selected.account.lastUsed ?? 0) >= 60_000) {
    storeFor(spec).saveAccount({ ...selected.account, ...credential, lastUsed: now });
  }
  return oauth.toAuth(credential);
}

export function registerPooledOAuthProvider<TApi extends Api>(pi: ExtensionAPI, spec: PooledOAuthProviderSpec<TApi>): void {
  const provider = spec.createProvider();
  const oauth = provider.auth.oauth;
  if (!oauth) return;

  const withQuotaObserver = (options: any) => ({
    ...options,
    onResponse: async (response: { status: number; headers: Record<string, string> }, model: unknown) => {
      try {
        recordQuotaResponse(spec, requestAccessToken(options), response.status, response.headers);
      } catch {
        // Quota accounting is telemetry; it must never fail the response.
      }
      await options?.onResponse?.(response, model);
    },
  });

  pi.registerProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        toAuth: (primary) => routedAuth(spec, oauth, primary),
      },
    },
    stream: (model: any, context: any, options: any) => provider.stream(model, context, withQuotaObserver(options)),
    streamSimple: (model: any, context: any, options: any) => provider.streamSimple(model, context, withQuotaObserver(options)),
  });
}

function requestAccessToken(options: any): string | undefined {
  if (typeof options?.apiKey === "string") return options.apiKey;
  const headers = options?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

/** Resolves which pooled account served a request, falling back to the primary. */
function accountIdForToken<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>, access: string | undefined): string {
  if (!access) return MAIN;
  return storeFor(spec).load().accounts.find((candidate) => candidate.access === access)?.id ?? MAIN;
}

function recordQuotaResponse<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  access: string | undefined,
  status: number,
  headers: Record<string, string>,
): void {
  if (spec.recordQuota) {
    spec.recordQuota(accountIdForToken(spec, access), status, headers);
    return;
  }

  if (!access) return;
  const store = storeFor(spec);
  const account = store.load().accounts.find((candidate) => candidate.access === access);
  const previous = account?.quota ?? store.primaryQuota();
  const quota = quotaStateFromHeaders(status, headers, previous);
  if (!quota || quota === previous) return;

  if (account) store.saveAccount({ ...account, quota });
  else setPrimaryQuota(spec.id, quota);
}
