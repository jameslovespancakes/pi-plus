import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAccountProvider } from "../../core/accounts/registry.ts";
import { anthropicAccounts } from "./providers/anthropic.ts";
import { codexAccounts, registerCodexProvider } from "./providers/codex.ts";
import { kimiAccounts, KIMI_SPEC, xaiAccounts, XAI_SPEC } from "./providers/hosted.ts";
import { registerPooledOAuthProvider } from "./providers/oauth-pool.ts";
import { registerAnthropicProvider } from "./provider.ts";
import { registerAccountCommands } from "./accounts.ts";
import { registerRoutingCommands } from "./routing.ts";
import { registerFooter } from "./footer.ts";

/** Registers subscription providers, pooled accounts, routing, and usage UI. */
export default function subscriptions(pi: ExtensionAPI) {
  for (const provider of [anthropicAccounts, codexAccounts, kimiAccounts, xaiAccounts]) {
    registerAccountProvider(provider);
  }

  registerAnthropicProvider(pi);
  registerCodexProvider(pi);
  registerPooledOAuthProvider(pi, KIMI_SPEC);
  registerPooledOAuthProvider(pi, XAI_SPEC);

  registerAccountCommands(pi);
  registerRoutingCommands(pi);
  registerFooter(pi);
}
