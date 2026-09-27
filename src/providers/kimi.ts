import { builtinProvider } from "./shared/builtin.ts";
import { createPooledOAuthAdapter, type PooledOAuthProviderSpec } from "./shared/serving.ts";

export const KIMI_SPEC: PooledOAuthProviderSpec<"anthropic-messages"> = {
  id: "kimi-coding",
  label: "Kimi",
  createProvider: () => builtinProvider("kimi-coding"),
};
export const kimiAccounts = createPooledOAuthAdapter(KIMI_SPEC);
