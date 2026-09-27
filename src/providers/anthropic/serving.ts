import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicAccountIdentity, cachedAnthropicAccountIdentity } from "./identity.ts";
import { familyForModel, routingQuota } from "./routing.ts";
import { getRoutingMode, loadAccounts, saveAccount, saveAccounts } from "./store.ts";
import { cachedClaudeCooldown, cachedClaudeQuota, observeClaudeQuota, readClaudeQuota } from "./usage-cache.ts";
import { registerPooledOAuthProvider } from "../shared/serving.ts";
import { ensureAccessToken } from "./quota.ts";
import type { RecoveryScheduler } from "../shared/accounts/request-recovery.ts";

/** Claude retains its own storage and telemetry, but shares request recovery with other pools. */
export function registerClaudeRouting(pi: ExtensionAPI, provider: Provider, scheduler?: RecoveryScheduler): void {
  registerPooledOAuthProvider(pi, {
    id: "anthropic", label: "Claude", createProvider: () => provider,
    store: {
      load() {
        const storage = loadAccounts();
        return {
          mode: storage ? getRoutingMode(storage) : "sequential",
          accounts: (storage?.accounts ?? []).filter((account) => account.type === "oauth").map((account) => ({
            ...account, type: "oauth" as const, access: account.access ?? "", refresh: account.refresh ?? "",
            expires: account.expires ?? 0, addedAt: account.addedAt ?? 0, label: account.label ?? "", quota: undefined,
          })),
        };
      },
      saveAccount(account) {
        const { quota: _quota, ...credential } = account;
        saveAccount(credential);
      },
      saveMode(mode) {
        const storage = loadAccounts() ?? { accounts: [] };
        storage.routing = { ...storage.routing, mode };
        saveAccounts(storage);
      },
      primaryQuota: () => undefined,
    },
    identityOfCredential: (credential) => cachedAnthropicAccountIdentity(credential.access)
      ?? loadAccounts()?.accounts.find((account) => account.access === credential.access)?.identity,
    onPrimary(credential) {
      if (!cachedAnthropicAccountIdentity(credential.access)) void anthropicAccountIdentity(credential.access).catch(() => {});
    },
    quotaFor(credential: OAuthCredential, modelId) {
      const account = loadAccounts()?.accounts.find((candidate) => candidate.access === credential.access);
      const target = { access: credential.access, id: account?.id,
        identity: account?.identity ?? cachedAnthropicAccountIdentity(credential.access), quota: account?.quota };
      const quota = routingQuota(cachedClaudeQuota(target), familyForModel(modelId), modelId);
      const blockedUntil = cachedClaudeCooldown(target, modelId);
      return blockedUntil ? { ...quota, checkedAt: quota?.checkedAt ?? Date.now(), blockedUntil } : quota;
    },
    async checkQuota(accountId, credential, _modelId, signal) {
      const account = loadAccounts()?.accounts.find((candidate) => candidate.id === accountId);
      await readClaudeQuota({ access: credential.access, id: account?.id,
        identity: account?.identity ?? cachedAnthropicAccountIdentity(credential.access), quota: account?.quota }, Date.now(), signal);
    },
    async refreshCredential(account) {
      const access = await ensureAccessToken({ ...account, quota: undefined });
      const latest = loadAccounts()?.accounts.find((candidate) => candidate.id === account.id);
      if (!access || !latest?.refresh || latest.expires === undefined) throw new Error("401 Claude account needs reauthorization.");
      return { ...account, access, refresh: latest.refresh, expires: latest.expires };
    },
    recordQuota(_accountId, status, headers, credential, modelId) {
      if (credential) observeClaudeQuota(credential.access, headers, Date.now(), { status, modelId });
    },
  }, scheduler);
}
