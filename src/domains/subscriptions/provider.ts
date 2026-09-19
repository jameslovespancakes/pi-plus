import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { authorize, exchange, refreshToken } from "../../core/anthropic/oauth.ts";
import {
  billingHeader, clientIdentityHeaders, firstUserText, prependPromptBlock, signRequestBody, splitSystemPrompt,
} from "../../core/anthropic/client-identity.ts";
import { ANTHROPIC_MODELS } from "../../core/anthropic/models.ts";
import { QUOTA_FRESH_MS, refreshAllQuota } from "../../core/anthropic/quota.ts";
import {
  MAIN_ACCOUNT_ID, candidateWeight, familyForModel, selectAccount, type Candidate,
} from "../../core/anthropic/routing.ts";
import { getRoutingMode, loadAccounts, saveAccount, type Account } from "../../core/anthropic/store.ts";

/**
 * The Anthropic provider.
 *
 * Rather than reimplementing the Messages API, this registers pi's built-in
 * `anthropic-messages` implementation and supplies only the credential. pi
 * resolves auth per request, so `getApiKey` is the hook where account routing
 * happens: it returns the token of whichever account the router picked.
 *
 * Consequences of that choice, stated plainly:
 *   - `getApiKey` is synchronous, so selection reads the CACHED quota snapshot.
 *     A background timer keeps it fresh instead of polling inline.
 *   - A mid-stream 429 is handled by pi's retry rather than by migrating the
 *     in-flight request to another account. The next request routes elsewhere
 *     once the failure is recorded, which is a real behavioural difference from
 *     the vendored provider.
 *
 * What this buys: pi's streaming, tool conversion, cost accounting and retry
 * logic are reused unchanged, instead of a 1,500-line reimplementation whose
 * edge cases we could not see.
 */

let lastSelected: { id: string; at: number } | undefined;

/** Which account served the most recent request, for the UI. */
export function lastRoutedAccount(): { id: string; at: number } | undefined {
  return lastSelected;
}

/**
 * Chooses an account and returns its access token.
 *
 * `primary` is pi's own credential, which participates as `main` at order 0.
 * Falls back to the primary token whenever routing has nothing better, so a
 * single-account setup behaves exactly as it did before any of this existed.
 */
export function routeAccessToken(primary: string, modelId?: string, sessionId?: string): string {
  const storage = loadAccounts();
  if (!storage) return primary;

  const mode = getRoutingMode(storage);
  const family = familyForModel(modelId);

  const candidates: Candidate[] = [
    { id: MAIN_ACCOUNT_ID, access: primary, quota: storage.main?.quota as any, order: 0 },
    ...storage.accounts
      .filter((a) => a.enabled !== false && a.type === "oauth" && a.access)
      .map((a, index) => ({ id: a.id, access: a.access, quota: a.quota, order: index + 1, account: a })),
  ];

  // Nothing to choose between: keep pi's own credential.
  if (candidates.length <= 1) return primary;

  const picked = selectAccount({ candidates, family, modelId, mode });
  if (!picked) {
    // Everything is quota-blocked. Returning the primary lets Anthropic issue
    // the authoritative 429 rather than inventing a local failure.
    return primary;
  }

  lastSelected = { id: picked.candidate.id, at: Date.now() };
  if (picked.candidate.account) {
    saveAccount({ ...picked.candidate.account, lastUsed: Date.now() });
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
    // See core/anthropic/client-identity.ts. Without these, Anthropic bills
    // requests to extra usage rather than plan limits. Delete that import and
    // this line to opt out; nothing else depends on it.
    headers: clientIdentityHeaders(),
    oauth: {
      name: "Anthropic Claude Pro/Max",
      isSubscription: true,
      login,
      refreshToken: async (credentials: any) => {
        const refreshed = await refreshToken({ refreshToken: credentials.refresh });
        return { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
      },
      // The routing hook. pi calls this per request.
      getApiKey: (credentials: any) => routeAccessToken(credentials.access),
    },
  });

  /**
   * Reshapes the request the way the endpoint requires, then signs it.
   *
   * Three things have to happen, in order:
   *   1. pi's system prompt is split. The documentation paragraph cannot live in
   *      `system` at all, or Anthropic answers 400 "Third-party apps now draw
   *      from your extra usage"; it moves into the first user message instead.
   *   2. The billing header goes first in `system`, alongside the Claude Code
   *      identity line.
   *   3. The body is signed, which must happen last because the checksum covers
   *      the canonicalised body.
   *
   * See core/anthropic/client-identity.ts for what all of this is and the
   * caveats around it.
   */
  pi.on("before_provider_request", async (event: any) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;

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

  // Quota drives selection, so keep the snapshot warm out of band. Failures are
  // silent by design: stale quota degrades routing, it does not break requests.
  pi.on("session_start", async () => {
    void refreshAllQuota().catch(() => {});
    const timer = setInterval(() => void refreshAllQuota().catch(() => {}), QUOTA_FRESH_MS);
    timer.unref?.();
  });
}
