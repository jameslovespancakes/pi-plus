import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { authorize, exchange, refreshToken } from "../../core/anthropic/oauth.ts";
import {
  billingHeader, clientIdentityHeaders, firstUserText, identityBetas, prependPromptBlock, signRequestBody,
  splitSystemPrompt,
} from "../../core/anthropic/client-identity.ts";
import {
  anthropicAccountIdentity,
  cachedAnthropicAccountIdentity,
} from "../../core/anthropic/identity.ts";
import { catalogIsStale, refreshAnthropicCatalog } from "../../core/anthropic/catalog.ts";
import { ANTHROPIC_MODELS, buildAnthropicModels, type ModelSpec } from "../../core/anthropic/models.ts";
import {
  ACCESS_REFRESH_INTERVAL_MS,
  refreshDueAccessTokens,
} from "../../core/anthropic/quota.ts";
import {
  MAIN_ACCOUNT_ID, familyForModel, selectAccount, type Candidate,
} from "../../core/anthropic/routing.ts";
import { getRoutingMode, loadAccounts, saveAccount } from "../../core/anthropic/store.ts";
import { cachedClaudeQuota, observeClaudeQuota } from "../../core/anthropic/usage-cache.ts";
import { refreshAbortSignal } from "../../core/accounts/routing.ts";

/**
 * Anthropic uses pi's Messages API client with per-request account routing.
 * Routing reads cached quota; a 429 affects the next request, not its stream.
 */

/**
 * The hook is global, so require both Anthropic's payload shape and a Claude
 * model. This prevents `system` injection into other provider requests.
 */
function isAnthropicMessagesPayload(payload: any): boolean {
  if ("instructions" in payload || "input" in payload) return false;
  if (!Array.isArray(payload.messages)) return false;
  const model = typeof payload.model === "string" ? payload.model.toLowerCase() : "";
  return model.startsWith("claude") || registeredModels.some((m) => m.id === payload.model);
}

/** The catalogue currently registered; replaced when discovery finds a new model. */
let registeredModels: ModelSpec[] = ANTHROPIC_MODELS;

const accountLastUsed = new Map<string, number>();

/** Routes to a pooled account, falling back to pi's primary credential. */
export function routeAccessToken(primary: string, modelId?: string, _sessionId?: string): string {
  const storage = loadAccounts();
  if (!storage) return primary;

  const mode = getRoutingMode(storage);
  const family = familyForModel(modelId);
  const primaryIdentity = cachedAnthropicAccountIdentity(primary);
  if (!primaryIdentity) void anthropicAccountIdentity(primary).catch(() => {});
  const identities = new Set(primaryIdentity ? [primaryIdentity] : []);
  const sidecars = storage.accounts.filter((account) => {
    if (account.enabled === false || account.type !== "oauth" || !account.access
      || typeof account.expires !== "number" || account.expires <= Date.now()) return false;
    if (!account.identity) return true;
    if (identities.has(account.identity)) return false;
    identities.add(account.identity);
    return true;
  });

  const candidates: Candidate[] = [
    {
      id: MAIN_ACCOUNT_ID,
      access: primary,
      quota: cachedClaudeQuota({ access: primary, identity: primaryIdentity,
        quota: storage.accounts.find((account) => primaryIdentity && account.identity === primaryIdentity)?.quota }),
      order: 0,
      lastUsed: accountLastUsed.get(MAIN_ACCOUNT_ID) ?? Number(storage.main?.lastUsed ?? 0),
    },
    // Never route an expired/unknown-lifetime sidecar while its asynchronous
    // refresher catches up; falling back to pi's primary is safer than a 401.
    // Stable identities also keep duplicate logins from inflating the pool.
    ...sidecars.map((a, index) => ({
        id: a.id,
        access: a.access,
        quota: cachedClaudeQuota({ access: a.access!, id: a.id, identity: a.identity, quota: a.quota }),
        order: index + 1,
        lastUsed: accountLastUsed.get(a.id) ?? a.lastUsed ?? 0,
        account: a,
      })),
  ];

  // Nothing to choose between: keep pi's own credential.
  if (candidates.length <= 1) return primary;

  const picked = selectAccount({ candidates, family, modelId, mode });
  if (!picked) {
    // Everything is quota-blocked. Returning the primary lets Anthropic issue
    // the authoritative 429 rather than inventing a local failure.
    return primary;
  }

  const now = Date.now();
  accountLastUsed.set(picked.candidate.id, now);
  if (picked.candidate.account) {
    // Minute precision avoids a credential write on every request.
    const previous = picked.candidate.account.lastUsed ?? 0;
    if (now - previous > 60_000) {
      saveAccount({ ...picked.candidate.account, lastUsed: now });
    }
  }
  return picked.candidate.access ?? primary;
}

async function login(callbacks: any) {
  const auth = await authorize("max");
  callbacks.onAuth({ url: auth.url });
  const pasted = await callbacks.onPrompt({ message: "Paste the Claude OAuth callback URL or code:" });
  const result = await exchange(pasted, auth.verifier, auth.redirectUri, auth.state);
  if (result.type !== "success") throw new Error(`Anthropic OAuth failed: ${result.reason}`);
  return { access: result.access, refresh: result.refresh, expires: result.expires };
}

/**
 * Asks Anthropic which models this subscription can actually use.
 *
 * pi's catalogue is generated at build time, so a newly shipped model is
 * missing until pi is upgraded. Discovery is best-effort and off the request
 * path: a failure leaves the bundled catalogue in place, which is exactly the
 * behaviour without this function.
 */
async function discoverModels(pi: ExtensionAPI, ctx: any, force = false): Promise<void> {
  if (!force && !catalogIsStale()) return;
  try {
    const resolved = await ctx.modelRegistry?.getProviderAuth?.("anthropic");
    if (!resolved?.auth) return;

    const added = await refreshAnthropicCatalog(
      { ...resolved.auth, source: resolved.source },
      refreshAbortSignal(ctx.signal),
    );
    if (added.length === 0) return;

    registeredModels = buildAnthropicModels();
    registerProvider(pi);
    ctx.ui?.notify?.(`New Anthropic models available: ${added.join(", ")}`, "info");
  } catch {
    // Offline, rate limited, or an expired credential: keep what we have.
  }
}

function registerProvider(pi: ExtensionAPI): void {
  pi.registerProvider("anthropic", {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: registeredModels,
    // Required for subscription billing. See client-identity.ts.
    headers: clientIdentityHeaders(),
    oauth: {
      name: "Anthropic Claude Pro/Max",
      isSubscription: true,
      login,
      refreshToken: async (credentials: any) => {
        const refreshed = await refreshToken({ refreshToken: credentials.refresh });
        return { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
      },
      getApiKey: (credentials: any) => routeAccessToken(credentials.access),
    },
  });
}

export function registerAnthropicProvider(pi: ExtensionAPI): void {
  registerProvider(pi);

  pi.registerCommand("models-refresh", {
    description: "Re-ask subscription providers which models your accounts can use",
    handler: async (_args, ctx: any) => {
      await discoverModels(pi, ctx, true);
      // Live catalogues (Gemini's, pi's remote ones) answer pi's own
      // refresh; `force` bypasses their freshness windows.
      const result = await ctx.modelRegistry?.refresh?.({ force: true }).catch(() => undefined);
      const failed = [...(result?.errors?.keys?.() ?? [])];
      ctx.ui.notify(
        `${registeredModels.length} Anthropic models available.`
          + (failed.length > 0 ? ` Could not refresh: ${failed.join(", ")}.` : " Other catalogues refreshed."),
        failed.length > 0 ? "warning" : "info",
      );
    },
  });

  /** Rebuilds the Anthropic prompt, then signs the final body. */
  pi.on("before_provider_request", async (event: any) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    if (!isAnthropicMessagesPayload(payload)) return undefined;

    const serialized = typeof payload.system === "string"
      ? payload.system
      : (payload.system ?? []).map((b: any) => b?.text ?? "").join("\n\n");
    const split = splitSystemPrompt(serialized);

    const messages = structuredClone(payload.messages ?? []);
    prependPromptBlock(messages, split.messageText);

    const system = [
      { type: "text", text: billingHeader(firstUserText(messages)) },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ...(split.systemText ? [{ type: "text", text: split.systemText }] : []),
    ];

    // Union, not replacement: pi's betas authorise fields pi itself emits.
    const betas = identityBetas(payload, Array.isArray(payload.betas) ? payload.betas : []);

    const signed = await signRequestBody(JSON.stringify({ ...payload, betas, system, messages }));
    return JSON.parse(signed);
  });

  // Capture the credential actually sent by this session, not global routing state.
  let requestAccess: string | undefined;
  pi.on("before_provider_headers", (event) => {
    const authorization = Object.entries(event.headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
    requestAccess = typeof authorization === "string" && /^Bearer sk-ant-oat/i.test(authorization)
      ? authorization.slice(7) : undefined;
  });
  pi.on("after_provider_response", (event) => {
    const access = requestAccess;
    requestAccess = undefined;
    if (!access) return;
    try { observeClaudeQuota(access, event.headers); }
    catch { /* Telemetry must never disturb inference. */ }
  });

  /**
   * Keep rotating sidecar credentials even while their quota snapshot is fresh.
   * CortexKit refreshes fallbacks on an independent background cadence for the
   * same reason: quota freshness is not credential freshness.
   */
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const startRefreshLoop = () => {
    if (refreshTimer) return;
    refreshTimer = setInterval(
      () => void refreshDueAccessTokens().catch(() => {}),
      ACCESS_REFRESH_INTERVAL_MS + Math.floor(Math.random() * 30_000),
    );
    refreshTimer.unref?.();
  };

  pi.on("input", async () => {
    startRefreshLoop();
    void refreshDueAccessTokens().catch(() => {});
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    startRefreshLoop();
    void refreshDueAccessTokens().catch(() => {});
    // Off the request path and TTL-gated, so this is one call a day at most.
    void discoverModels(pi, ctx).catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
