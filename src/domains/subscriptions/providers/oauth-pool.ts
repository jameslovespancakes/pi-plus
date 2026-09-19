import { randomUUID } from "node:crypto";
import type { ModelAuth, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountContext, AccountProvider, ManagedAccount, RoutingMode } from "../../../core/accounts/registry.ts";
import {
  loadOAuthPool,
  oauthIdentity,
  saveOAuthAccount,
  saveOAuthPool,
  setOAuthPoolMode,
  type PooledOAuthAccount,
} from "../../../core/accounts/oauth-pool.ts";

export interface PooledOAuthProviderSpec {
  id: string;
  label: string;
  createProvider(): Provider;
}

const lastUsed = new Map<string, number>();
const refreshes = new Map<string, Promise<PooledOAuthAccount>>();

function oauthFor(spec: PooledOAuthProviderSpec): OAuthAuth {
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

async function authenticate(spec: PooledOAuthProviderSpec, ctx: AccountContext): Promise<OAuthCredential> {
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

function accountLabel(account: PooledOAuthAccount): string {
  return account.label || account.identity || account.id.slice(0, 8);
}

function duplicateAccount(spec: PooledOAuthProviderSpec, credential: OAuthCredential, excludeId?: string): PooledOAuthAccount | undefined {
  const identity = oauthIdentity(credential.access);
  return loadOAuthPool(spec.id).accounts.find((account) =>
    account.id !== excludeId && (identity ? account.identity === identity : account.access === credential.access));
}

export function createPooledOAuthAdapter(spec: PooledOAuthProviderSpec): AccountProvider {
  return {
    id: spec.id,
    label: spec.label,

    async list(): Promise<ManagedAccount[]> {
      return loadOAuthPool(spec.id).accounts.map((account) => ({
        id: account.id,
        label: accountLabel(account),
        enabled: account.enabled !== false,
        expiresAt: account.expires,
      }));
    },

    async add(ctx, label): Promise<string | undefined> {
      if (!await ctx.ui.confirm(`Add ${spec.label} account`, `Sign in with another ${spec.label} subscription?`)) {
        return undefined;
      }
      const credential = await authenticate(spec, ctx);
      const duplicate = duplicateAccount(spec, credential);
      if (duplicate) throw new Error(`That account is already saved as “${accountLabel(duplicate)}”.`);

      saveOAuthAccount(spec.id, {
        ...credential,
        id: randomUUID(),
        label,
        enabled: true,
        identity: oauthIdentity(credential.access),
        addedAt: Date.now(),
      });
      return label;
    },

    async reauth(ctx, accountId): Promise<string | undefined> {
      const account = loadOAuthPool(spec.id).accounts.find(
        (candidate) => candidate.id === accountId || candidate.label === accountId,
      );
      if (!account) throw new Error(`${spec.label} account “${accountId}” not found.`);

      const credential = await authenticate(spec, ctx);
      const duplicate = duplicateAccount(spec, credential, account.id);
      if (duplicate) throw new Error(`That account is already saved as “${accountLabel(duplicate)}”.`);
      saveOAuthAccount(spec.id, {
        ...account,
        ...credential,
        identity: oauthIdentity(credential.access),
      });
      return account.label;
    },

    async setEnabled(accountId, enabled): Promise<void> {
      const pool = loadOAuthPool(spec.id);
      const account = pool.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error(`${spec.label} account “${accountId}” not found.`);
      account.enabled = enabled;
      saveOAuthPool(spec.id, pool);
    },

    async rename(accountId, label): Promise<void> {
      const pool = loadOAuthPool(spec.id);
      const account = pool.accounts.find((candidate) => candidate.id === accountId);
      if (!account) throw new Error(`${spec.label} account “${accountId}” not found.`);
      account.label = label;
      saveOAuthPool(spec.id, pool);
    },

    routing: {
      async get(): Promise<RoutingMode> {
        return loadOAuthPool(spec.id).mode;
      },
      async set(mode): Promise<RoutingMode> {
        setOAuthPoolMode(spec.id, mode);
        return mode;
      },
      describe(mode): string {
        return mode === "optimal"
          ? `Rotates requests across enabled ${spec.label} subscriptions.`
          : `Uses the primary ${spec.label} subscription.`;
      },
    },
  };
}

function chooseCredential(
  spec: PooledOAuthProviderSpec,
  primary: OAuthCredential,
): { id: string; credential: OAuthCredential; account?: PooledOAuthAccount } {
  const pool = loadOAuthPool(spec.id);
  if (pool.mode === "standard") return { id: "main", credential: primary };

  const candidates = [
    { id: "main", credential: primary, usedAt: lastUsed.get(`${spec.id}:main`) ?? 0, order: 0 },
    ...pool.accounts
      .filter((account) => account.enabled !== false && account.access)
      .map((account, index) => ({
        id: account.id,
        credential: account,
        account,
        usedAt: lastUsed.get(`${spec.id}:${account.id}`) ?? account.lastUsed ?? 0,
        order: index + 1,
      })),
  ];
  candidates.sort((left, right) => left.usedAt - right.usedAt || left.order - right.order);
  return candidates[0];
}

async function freshCredential(spec: PooledOAuthProviderSpec, account: PooledOAuthAccount, signal: AbortSignal): Promise<PooledOAuthAccount> {
  if (account.expires > Date.now() + 60_000) return account;

  const key = `${spec.id}:${account.id}`;
  const active = refreshes.get(key);
  if (active) return active;

  const refresh = oauthFor(spec).refresh(account, signal).then((credential) => {
    const updated = { ...account, ...credential };
    saveOAuthAccount(spec.id, updated);
    return updated;
  }).finally(() => refreshes.delete(key));
  refreshes.set(key, refresh);
  return refresh;
}

async function routedAuth(
  spec: PooledOAuthProviderSpec,
  oauth: OAuthAuth,
  primary: OAuthCredential,
): Promise<ModelAuth> {
  const selected = chooseCredential(spec, primary);
  const signal = new AbortController().signal;
  const credential = selected.account
    ? await freshCredential(spec, selected.account, signal)
    : primary;
  const now = Date.now();
  lastUsed.set(`${spec.id}:${selected.id}`, now);

  if (selected.account && now - (selected.account.lastUsed ?? 0) >= 60_000) {
    saveOAuthAccount(spec.id, { ...selected.account, ...credential, lastUsed: now });
  }
  return oauth.toAuth(credential);
}

export function registerPooledOAuthProvider(pi: ExtensionAPI, spec: PooledOAuthProviderSpec): void {
  const provider = spec.createProvider();
  const oauth = provider.auth.oauth;
  if (!oauth) return;

  pi.registerProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        toAuth: (primary) => routedAuth(spec, oauth, primary),
      },
    },
  });
}
