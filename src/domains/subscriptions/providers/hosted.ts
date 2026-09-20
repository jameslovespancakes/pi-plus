import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { createPooledOAuthAdapter, type PooledOAuthProviderSpec } from "./oauth-pool.ts";

export const KIMI_SPEC: PooledOAuthProviderSpec<"anthropic-messages"> = {
  id: "kimi-coding",
  label: "Kimi",
  createProvider: kimiCodingProvider,
};

export const XAI_SPEC: PooledOAuthProviderSpec<"openai-responses"> = {
  id: "xai",
  label: "Grok",
  createProvider: xaiProvider,
};

export const kimiAccounts = createPooledOAuthAdapter(KIMI_SPEC);
export const xaiAccounts = createPooledOAuthAdapter(XAI_SPEC);
