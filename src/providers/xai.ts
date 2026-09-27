import { builtinProvider } from "./shared/builtin.ts";
import { createPooledOAuthAdapter, type PooledOAuthProviderSpec } from "./shared/serving.ts";

export const XAI_SPEC: PooledOAuthProviderSpec<"openai-responses"> = {
  id: "xai",
  label: "Grok",
  createProvider: () => builtinProvider("xai"),
};
export const xaiAccounts = createPooledOAuthAdapter(XAI_SPEC);
