import { builtinProvider } from "./builtin.ts";
import { createPooledOAuthAdapter, type PooledOAuthProviderSpec } from "./oauth-pool.ts";

export const KIMI_SPEC: PooledOAuthProviderSpec<"anthropic-messages"> = {
  id: "kimi-coding",
  label: "Kimi",
  createProvider: () => builtinProvider("kimi-coding"),
};

export const XAI_SPEC: PooledOAuthProviderSpec<"openai-responses"> = {
  id: "xai",
  label: "Grok",
  createProvider: () => builtinProvider("xai"),
};

export const kimiAccounts = createPooledOAuthAdapter(KIMI_SPEC);
export const xaiAccounts = createPooledOAuthAdapter(XAI_SPEC);
