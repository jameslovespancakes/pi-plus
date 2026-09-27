import { randomUUID } from "node:crypto";
import { accountRetryAt } from "./accounts/provider-errors.ts";
import { streamWithRecovery, type RecoveryScheduler, type RecoveryReason } from "./accounts/request-recovery.ts";
import type { Api, AssistantMessage, ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "./accounts/registry.ts";
import {
  quotaStateFromHeaders,
  refreshAbortSignal,
  selectRoutingCandidate,
  type AccountQuotaState,
} from "./accounts/routing.ts";
import {
  oauthIdentity,
  setPrimaryQuota,
  sharedOAuthPoolStore,
  type PooledOAuthAccount,
  type PooledOAuthStore,
} from "./accounts/oauth-pool.ts";

export interface PooledOAuthProviderSpec<TApi extends Api> {
  id: string;
  label: string;
  createProvider(): Provider<TApi>;
  classifyFailure?(message: AssistantMessage): RecoveryReason | undefined;
  /** Backing storage. Defaults to the shared pi-plus OAuth pool file. */
  store?: PooledOAuthStore;
  /** Confirmation shown before an interactive `add`. */
  addPrompt?: string;
  /** Display label for an account. */
  describeAccount?(account: PooledOAuthAccount): string;
  /** Stable identity used to reject a duplicate login. Defaults to JWT claims. */
  identityOf?(access: string): string | undefined;
  /**
   * Identity read from the whole credential rather than the access token.
   * Providers that issue opaque tokens (Google hands out `ya29.` strings with
   * no readable claims) have no identity inside the token at all, so a stable
   * value discovered at login — an email, say — is stored alongside it and
   * read back here. Takes precedence over `identityOf` when present.
   */
  identityOfCredential?(credential: OAuthCredential): string | undefined;
  /**
   * Recovers the access token from what `toAuth()` put in `options.apiKey`,
   * for providers that encode more than the token there. Without it, quota
   * observed on a response cannot be attributed to the account that served it.
   */
  accessTokenOf?(apiKey: string): string | undefined;
  /**
   * Records a response's quota signal against an account. Defaults to the
   * generic `x-ratelimit-*` reader; providers with their own headers (Codex
   * sends `x-codex-*`) override it. Must never throw: it runs inside the
   * awaited `onResponse`, so a rejection would kill an in-flight stream.
   */
  recordQuota?(accountId: string, status: number, headers: Record<string, string>, credential?: OAuthCredential, modelId?: string): void;
  quotaFor?(credential: OAuthCredential, modelId?: string, accountId?: string): AccountQuotaState | undefined;
  onPrimary?(credential: OAuthCredential): void;
  /** Reuse a provider's existing credential refresh coordination when it has one. */
  refreshCredential?(account: PooledOAuthAccount): Promise<OAuthCredential>;
  /** Model/family key for providers whose allowances are independently scoped. */
  quotaScope?(modelId: string): string;
  /** Non-inference usage check after a limit failure. May return a usage-endpoint cooldown. */
  checkQuota?(accountId: string, credential: OAuthCredential, modelId: string, signal: AbortSignal): Promise<number | void>;
}

interface RoutedCredential {
  id: string;
  credential: OAuthCredential;
  account?: PooledOAuthAccount;
  responseStatus?: number;
}

const MAIN = "main";
const POOLED = Symbol.for("pi-plus.pooled-oauth");

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
    // `prompt.signal` lets a flow retract a prompt, e.g. the paste box once
    // the browser callback has already answered it.
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        const labels = prompt.options.map((option) => option.label);
        const selected = await ctx.ui.select(prompt.message, labels, { signal: prompt.signal });
        const index = selected ? labels.indexOf(selected) : -1;
        if (index < 0) throw new Error("Login cancelled.");
        return prompt.options[index].id;
      }
      const value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal: prompt.signal });
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

/** Credential-wide identity where the provider has one, else the token's. */
function credentialIdentity<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  credential: OAuthCredential,
): string | undefined {
  return spec.identityOfCredential?.(credential) ?? identityFor(spec, credential.access);
}

function duplicateAccount<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  credential: OAuthCredential,
  excludeId?: string,
): PooledOAuthAccount | undefined {
  const identity = credentialIdentity(spec, credential);
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
        const identity = account.identity ?? credentialIdentity(spec, account);
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
        identity: credentialIdentity(spec, credential),
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
        identity: credentialIdentity(spec, credential),
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
  options: { excluded?: ReadonlySet<string>; modelId?: string } = {},
): RoutedCredential | undefined {
  const pool = storeFor(spec).load();
  const scope = options.modelId ? spec.quotaScope?.(options.modelId) : undefined;
  const primaryIdentity = credentialIdentity(spec, primary);
  const identities = new Set(primaryIdentity ? [primaryIdentity] : []);
  const tokens = new Set([primary.access]);
  const duplicate = pool.accounts.find((account) => primaryIdentity && credentialIdentity(spec, account) === primaryIdentity);
  const candidates = [
    {
      id: MAIN,
      order: 0,
      lastUsed: lastUsed.get(`${spec.id}:${MAIN}`) ?? 0,
      quota: spec.quotaFor ? spec.quotaFor(primary, options.modelId, MAIN) : storeFor(spec).primaryQuota(scope) ?? (scope ? duplicate?.modelQuotas?.[scope] : undefined) ?? duplicate?.quota,
      value: { id: MAIN, credential: primary },
    },
    ...pool.accounts
      .filter((account) => {
        if (account.enabled === false || !account.access || tokens.has(account.access)) return false;
        const identity = account.identity ?? credentialIdentity(spec, account);
        if (identity && identities.has(identity)) return false;
        tokens.add(account.access);
        if (identity) identities.add(identity);
        return true;
      })
      .map((account, index) => ({
        id: account.id,
        order: index + 1,
        lastUsed: lastUsed.get(`${spec.id}:${account.id}`) ?? account.lastUsed ?? 0,
        quota: spec.quotaFor ? spec.quotaFor(account, options.modelId, account.id) : (scope ? account.modelQuotas?.[scope] : undefined) ?? account.quota,
        value: { id: account.id, credential: account, account },
      })),
  ];
  return selectRoutingCandidate(candidates.filter((candidate) => !options.excluded?.has(candidate.id)), pool.mode)?.value;
}

async function freshCredential<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  account: PooledOAuthAccount,
): Promise<PooledOAuthAccount> {
  const current = storeFor(spec).load().accounts.find((candidate) => candidate.id === account.id);
  if (!current || current.enabled === false) throw new Error("401 OAuth account is no longer available.");
  account = current;
  if (account.expires > Date.now() + 60_000) return account;

  const key = `${spec.id}:${account.id}:${account.refresh}`;
  const active = refreshes.get(key);
  if (active) return active;

  // Bounded: nothing upstream constrains this call, and a hung refresh would be
  // shared by every later request for the account through the map above.
  const refresh = (spec.refreshCredential?.(account) ?? oauthFor(spec).refresh(account, refreshAbortSignal())).then((credential) => {
    const latest = storeFor(spec).load().accounts.find((candidate) => candidate.id === account.id);
    if (!latest || latest.enabled === false) throw new Error("401 OAuth account is no longer available.");
    if (latest.refresh !== account.refresh) return latest;
    const updated = { ...latest, ...credential, quota: latest.quota, modelQuotas: latest.modelQuotas };
    storeFor(spec).saveAccount(updated);
    return updated;
  }).finally(() => refreshes.delete(key));
  refreshes.set(key, refresh);
  return refresh;
}

export function registerPooledOAuthProvider<TApi extends Api>(
  pi: ExtensionAPI, spec: PooledOAuthProviderSpec<TApi>, scheduler?: RecoveryScheduler,
): void {
  const provider = spec.createProvider();
  const oauth = provider.auth.oauth;
  if (!oauth || (provider as any)[POOLED]) return;
  // Pi resolves/refreshes the primary credential. Retain only bounded, in-memory
  // associations so the stream boundary can route with the actual selected model.
  const primaries = new Map<string, { credential: OAuthCredential; auth: ModelAuth }>();
  const cooldowns = new Map<string, number>();
  const quotaChecks = new Map<string, { nextAt: number; pending: Promise<void> }>();
  const checkQuota = (selected: RoutedCredential, modelId: string): Promise<void> => {
    if (!spec.checkQuota) return Promise.resolve();
    const key = selected.credential.access;
    const previous = quotaChecks.get(key);
    if (previous && previous.nextAt > Date.now()) return previous.pending;
    const entry = { nextAt: Date.now() + 60_000, pending: Promise.resolve() };
    entry.pending = Promise.resolve().then(async () => {
      try {
        const nextAt = await spec.checkQuota!(selected.id, selected.credential, modelId, AbortSignal.timeout(5_000));
        if (typeof nextAt === "number" && Number.isFinite(nextAt)) entry.nextAt = Math.max(entry.nextAt, nextAt);
      } catch { /* A status outage must never prevent fallback to another account. */ }
    });
    quotaChecks.set(key, entry);
    while (quotaChecks.size > 128) quotaChecks.delete(quotaChecks.keys().next().value!);
    return entry.pending;
  };
  const wrap = (stream: any) => (model: any, context: any, options: any) => {
    const primary = primaries.get(requestAccessToken(spec, options) ?? "");
    if (!primary) return stream.call(provider, model, context, options); // API-key auth stays native
    return streamWithRecovery({
      model, signal: options?.signal, scheduler,
      next(excluded) {
        const unavailable = new Set(excluded);
        for (const [key, until] of cooldowns) {
          if (until <= Date.now()) { cooldowns.delete(key); continue; }
          if (key.endsWith(`:${model.id}`)) unavailable.add(key.slice(0, -model.id.length - 1));
        }
        return chooseCredential(spec, primary.credential, { excluded: unavailable, modelId: model.id });
      },
      async stream(selected) {
        const credential = selected.account ? await freshCredential(spec, selected.account) : primary.credential;
        options?.signal?.throwIfAborted();
        selected.credential = credential;
        const auth = await oauth.toAuth(credential);
        options?.signal?.throwIfAborted();
        const headers = { ...options?.headers };
        for (const key of Object.keys(primary.auth.headers ?? {})) {
          for (const actual of Object.keys(headers)) if (actual.toLowerCase() === key.toLowerCase()) delete headers[actual];
        }
        Object.assign(headers, auth.headers);
        const now = Date.now();
        lastUsed.set(`${spec.id}:${selected.id}`, now);
        if (selected.account && now - (selected.account.lastUsed ?? 0) >= 60_000) {
          const latest = storeFor(spec).load().accounts.find((account) => account.id === selected.id);
          if (latest) storeFor(spec).saveAccount({ ...latest, lastUsed: now });
        }
        return stream.call(provider, model, context, {
          ...options, ...auth, headers, maxRetries: 0,
          onResponse: async (response: { status: number; headers: Record<string, string> }, requestModel: unknown) => {
            selected.responseStatus = response.status;
            if (response.status === 429) {
              const key = `${selected.id}:${model.id}`;
              cooldowns.set(key, Math.max(cooldowns.get(key) ?? 0, accountRetryAt(response.headers)));
            }
            try { recordQuotaResponse(spec, selected.id, response.status, response.headers, credential, model.id); }
            catch { /* Telemetry never replaces a provider response. */ }
            await options?.onResponse?.(response, requestModel);
          },
        });
      },
      classify(selected, message) {
        const status = selected.responseStatus;
        if (status === 429) return "limit";
        if (status === 401 || status === 403) return "auth";
        if (status !== undefined && status >= 500 && status < 600) return "transient";
        return spec.classifyFailure?.(message);
      },
      async failed(selected, message, reason) {
        if (reason === "transient") return;
        const key = `${selected.id}:${model.id}`;
        const existing = cooldowns.get(key);
        const headers: Record<string, string> = existing ? { "retry-after": String(Math.max(0, (existing - Date.now()) / 1000)) } : {};
        const at = accountRetryAt(headers, message.errorMessage);
        cooldowns.set(key, at);
        if (reason === "limit") {
          recordQuotaResponse(spec, selected.id, 429,
            { "retry-after": String(Math.max(1, Math.ceil((at - Date.now()) / 1000))) }, selected.credential, model.id);
          await checkQuota(selected, model.id);
        }
        const scope = spec.quotaScope?.(model.id);
        const latest = selected.id === MAIN ? undefined : storeFor(spec).load().accounts.find((account) => account.id === selected.id);
        const quota = spec.quotaFor?.(selected.credential, model.id, selected.id)
          ?? (selected.id === MAIN ? storeFor(spec).primaryQuota(scope) : (scope ? latest?.modelQuotas?.[scope] : undefined) ?? latest?.quota);
        return Math.max(at, quota?.resetAt ?? 0, quota?.blockedUntil ?? 0);
      },
    });
  };
  const registered = {
    ...provider,
    [POOLED]: true,
    auth: { ...provider.auth, oauth: { ...oauth, toAuth: async (credential: OAuthCredential) => {
      const auth = await oauth.toAuth(credential);
      primaries.set(credential.access, { credential, auth });
      while (primaries.size > 32) primaries.delete(primaries.keys().next().value!);
      spec.onPrimary?.(credential);
      return auth;
    } } },
    stream: wrap(provider.stream), streamSimple: wrap(provider.streamSimple),
  };
  pi.registerProvider(registered);
}

function requestAccessToken<TApi extends Api>(spec: PooledOAuthProviderSpec<TApi>, options: any): string | undefined {
  if (typeof options?.apiKey === "string") {
    return spec.accessTokenOf ? spec.accessTokenOf(options.apiKey) : options.apiKey;
  }
  const headers = options?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

function recordQuotaResponse<TApi extends Api>(
  spec: PooledOAuthProviderSpec<TApi>,
  accountId: string,
  status: number,
  headers: Record<string, string>,
  credential: OAuthCredential,
  modelId: string,
): void {
  if (spec.recordQuota) {
    spec.recordQuota(accountId, status, headers, credential, modelId);
    return;
  }

  const store = storeFor(spec);
  const account = accountId === MAIN ? undefined : store.load().accounts.find((candidate) => candidate.id === accountId);
  if (accountId !== MAIN && !account) return;
  const scope = spec.quotaScope?.(modelId);
  const previous = account ? (scope ? account.modelQuotas?.[scope] : account.quota) : store.primaryQuota(scope);
  const quota = quotaStateFromHeaders(status, headers, previous);
  if (!quota || quota === previous) return;

  if (account) store.saveAccount(scope ? { ...account, modelQuotas: { ...account.modelQuotas, [scope]: quota } } : { ...account, quota });
  else setPrimaryQuota(spec.id, quota, scope);
}
