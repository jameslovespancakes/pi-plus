import { createProvider, type Api, type Model, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { recordOAuthQuota } from "../shared/accounts/oauth-pool.ts";
import { quotaStateFromWindows } from "../shared/accounts/routing.ts";
import { GEMINI_ENDPOINT, GeminiQuotaError, fetchAvailableModels, fetchUserQuota } from "./client.ts";
import { GEMINI_QUOTA_FAMILIES, geminiQuotaFamily } from "./quota.ts";
import { credentialEmail, decodeApiKey } from "./credentials.ts";
import {
  GEMINI_API,
  GEMINI_PROVIDER,
  STATIC_MODELS,
  buildCatalog,
  withStaticModels,
  type GeminiModel,
} from "./models.ts";
import { geminiOAuth, requestProjectId } from "./oauth.ts";
import { geminiApi } from "./stream.ts";
import { createPooledOAuthAdapter, type PooledOAuthProviderSpec } from "../shared/serving.ts";

/**
 * Gemini adapter.
 *
 * pi has no provider for Google's Antigravity backend, so this one is built
 * with pi's own `createProvider` and joins the same pooled serving path as
 * every other subscription: one `routedAuth`, one bounded refresh, one quota
 * observer, and `/accounts` management for free.
 *
 * The catalogue is live. pi already refreshes provider catalogues at startup,
 * on login and when the model picker opens; this answers those refreshes from
 * `fetchAvailableModels`, so a newly enabled model becomes selectable without
 * a pi-plus release. The wrapper mirrors pi's own `withRemoteCatalog`:
 * restore the stored list, honour a freshness window, and never lose the
 * last known catalogue to a failed fetch.
 */

/** pi refreshes whenever the picker opens; the backend's list changes far less often. */
export const CATALOG_TTL_MS = 4 * 60 * 60_000;

async function discover(context: RefreshModelsContext): Promise<GeminiModel[] | undefined> {
  const credential = context.credential;
  if (credential?.type !== "oauth" || !credential.access) return undefined;
  const runtimeModels = await fetchAvailableModels(credential.access, requestProjectId(credential), context.signal);
  return Object.keys(runtimeModels).length > 0 ? buildCatalog(runtimeModels) : undefined;
}

export function withLiveCatalog(base: Provider<typeof GEMINI_API>): Provider<typeof GEMINI_API> {
  let catalog: readonly GeminiModel[] = base.getModels();

  return {
    ...base,
    getModels: () => catalog,

    async refreshModels(context) {
      const stored = context.stored;
      const restored = withStaticModels((stored?.models ?? []) as Model<Api>[]);
      if (!(await context.publish({ update: () => { catalog = restored; } }))) return;

      if (!context.allowNetwork || context.signal.aborted) return;
      const checkedAt = stored?.checkedAt;
      if (!context.force && checkedAt !== undefined && Date.now() - checkedAt < CATALOG_TTL_MS) return;

      try {
        const discovered = await discover(context);
        if (!discovered || context.signal.aborted) return;
        await context.publish({
          persist: { models: discovered, checkedAt: Date.now() },
          update: () => { catalog = discovered; },
        });
      } catch (error) {
        // The last known catalogue stays in place. Only an explicit refresh
        // reports the failure; a background one is not worth interrupting for.
        if (context.force) throw error;
      }
    },
  };
}

export function createGeminiProvider(): Provider<typeof GEMINI_API> {
  return withLiveCatalog(createProvider({
    id: GEMINI_PROVIDER,
    name: "Gemini",
    baseUrl: GEMINI_ENDPOINT,
    auth: { oauth: geminiOAuth },
    models: STATIC_MODELS,
    api: geminiApi(),
  }));
}

export const GEMINI_SPEC: PooledOAuthProviderSpec<typeof GEMINI_API> = {
  id: GEMINI_PROVIDER,
  label: "Gemini",
  createProvider: createGeminiProvider,
  addPrompt: "Sign in with a DIFFERENT Google account in the browser. Continue?",
  // Google issues opaque `ya29.` tokens with no readable claims, so the
  // email discovered at login is what recognises a duplicate sign-in.
  identityOfCredential: (credential) => {
    const email = credentialEmail(credential);
    return email ? `email:${email.toLowerCase()}` : undefined;
  },
  quotaScope: (modelId) => geminiQuotaFamily(modelId) ?? modelId,
  async checkQuota(accountId, credential, _modelId, signal) {
    const startedAt = Date.now();
    try {
      const buckets = await fetchUserQuota(credential.access, requestProjectId(credential), signal);
      for (const family of GEMINI_QUOTA_FAMILIES) {
        const windows = buckets.filter((bucket) => geminiQuotaFamily(bucket.modelId) === family).map((bucket) => {
          const resetAt = Date.parse(bucket.resetTime ?? "");
          return { remainingPercent: bucket.remainingFraction * 100, ...(Number.isFinite(resetAt) && { resetAt }) };
        });
        const quota = quotaStateFromWindows(windows, startedAt);
        if (quota) recordOAuthQuota(GEMINI_PROVIDER, accountId, quota, family);
      }
    } catch (error) {
      if (error instanceof GeminiQuotaError) return error.retryAt;
      throw error;
    }
  },
  describeAccount: (account) => account.label || account.id.slice(0, 8),
  accessTokenOf: (apiKey) => {
    try {
      return decodeApiKey(apiKey).token;
    } catch {
      // Quota attribution is telemetry; an unreadable key is not an error here.
      return undefined;
    }
  },
};

export const geminiAccounts = createPooledOAuthAdapter(GEMINI_SPEC);
