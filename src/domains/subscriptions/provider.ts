import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { authorize, exchange, refreshToken } from "../../core/anthropic/oauth.ts";
import {
  billingHeader, clientIdentityHeaders, firstUserText, prependPromptBlock, signRequestBody, splitSystemPrompt,
} from "../../core/anthropic/client-identity.ts";
import {
  anthropicAccountIdentity,
  cachedAnthropicAccountIdentity,
} from "../../core/anthropic/identity.ts";
import { ANTHROPIC_MODELS } from "../../core/anthropic/models.ts";
import {
  ACCESS_REFRESH_INTERVAL_MS,
  applyQuotaHeaders,
  refreshAllQuota,
} from "../../core/anthropic/quota.ts";
import {
  MAIN_ACCOUNT_ID, familyForModel, selectAccount, type Candidate,
} from "../../core/anthropic/routing.ts";
import { getRoutingMode, loadAccounts, saveAccount } from "../../core/anthropic/store.ts";

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
  return model.startsWith("claude") || ANTHROPIC_MODELS.some((m: any) => m.id === payload.model);
}

let lastSelected: { id: string; at: number } | undefined;
const accountLastUsed = new Map<string, number>();

/** Which account served the most recent request, for the UI. */
export function lastRoutedAccount(): { id: string; at: number } | undefined {
  return lastSelected;
}

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
      quota: storage.main?.quota as any,
      order: 0,
      lastUsed: accountLastUsed.get(MAIN_ACCOUNT_ID) ?? Number(storage.main?.lastUsed ?? 0),
    },
    // Never route an expired/unknown-lifetime sidecar while its asynchronous
    // refresher catches up; falling back to pi's primary is safer than a 401.
    // Stable identities also keep duplicate logins from inflating the pool.
    ...sidecars.map((a, index) => ({
        id: a.id,
        access: a.access,
        quota: a.quota,
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
  lastSelected = { id: picked.candidate.id, at: now };
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

export function registerAnthropicProvider(pi: ExtensionAPI): void {
  pi.registerProvider("anthropic", {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: ANTHROPIC_MODELS,
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

    const signed = await signRequestBody(JSON.stringify({ ...payload, system, messages }));
    return JSON.parse(signed);
  });

  /** Updates the routed account from response quota headers. */
  pi.on("after_provider_response", (event: any) => {
    const routed = lastRoutedAccount();
    // The primary account lives in pi's auth store.
    if (!routed || routed.id === MAIN_ACCOUNT_ID) return;
    try {
      applyQuotaHeaders(routed.id, event?.headers);
    } catch {
      // Never let bookkeeping disturb a response.
    }
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
      () => void refreshAllQuota().catch(() => {}),
      ACCESS_REFRESH_INTERVAL_MS + Math.floor(Math.random() * 30_000),
    );
    refreshTimer.unref?.();
  };

  pi.on("input", async () => {
    startRefreshLoop();
    void refreshAllQuota().catch(() => {});
  });

  pi.on("session_start", async () => {
    startRefreshLoop();
    void refreshAllQuota().catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
