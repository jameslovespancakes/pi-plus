import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAccountProvider } from "./shared/accounts/registry.ts";
import { registerPooledOAuthProvider } from "./shared/serving.ts";
import { registerAnthropicProvider } from "./anthropic/provider.ts";
import { anthropicAccounts } from "./anthropic/accounts.ts";
import { codexAccounts, CODEX_SPEC } from "./codex/provider.ts";
import { geminiAccounts, GEMINI_SPEC } from "./gemini/provider.ts";
import { kimiAccounts, KIMI_SPEC } from "./kimi.ts";
import { xaiAccounts, XAI_SPEC } from "./xai.ts";

/** Composition only. Provider implementations never import an extension domain. */
export function registerProviders(pi: ExtensionAPI): void {
  for (const provider of [anthropicAccounts, codexAccounts, geminiAccounts, kimiAccounts, xaiAccounts]) {
    registerAccountProvider(provider);
  }
  registerAnthropicProvider(pi);
  registerPooledOAuthProvider(pi, CODEX_SPEC);
  registerPooledOAuthProvider(pi, GEMINI_SPEC);
  registerPooledOAuthProvider(pi, KIMI_SPEC);
  registerPooledOAuthProvider(pi, XAI_SPEC);
}
