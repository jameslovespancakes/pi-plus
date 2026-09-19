import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAccountProvider } from "../../core/accounts/registry.ts";
import { anthropicAccounts } from "./providers/anthropic.ts";
import { registerAccountCommands } from "./accounts.ts";
import { registerRoutingCommands } from "./routing.ts";
import { registerFooter } from "./footer.ts";

/**
 * Subscriptions domain — Claude OAuth accounts, routing mode, and the quota HUD.
 *
 * This replaces the old `claude-multi-account.ts` + `compact-footer.ts` pair.
 * Account and routing commands are provider-agnostic: `/account <provider>` and
 * `/routing` dispatch through core/accounts/registry.ts, so adding a second
 * provider means writing one adapter, not new commands.
 * Authentication and model catalogue are separate concerns here; they were only
 * ever colocated because they shared an OAuth token.
 *
 * Relationship to @cortexkit/pi-anthropic-auth:
 *   That package stays installed and keeps ownership of the Anthropic provider,
 *   its stream implementation, and its own commands (/claude-account,
 *   /claude-routing, /claude-quota, ...). Absorbing it fully was evaluated and
 *   rejected — its `dist/commands.js` exports only `registerCommands(pi)` as a
 *   unit, so taking over individual commands would mean copying ~130 lines of
 *   provider/model specs that drift on every vendor upgrade. This domain adds
 *   the multi-account surface the vendor does not provide, and everything it
 *   touches goes through src/vendor/anthropic.ts.
 */
export default function subscriptions(pi: ExtensionAPI) {
  // Adapters register first so the generic commands can see them.
  registerAccountProvider(anthropicAccounts);

  registerAccountCommands(pi);
  registerRoutingCommands(pi);
  registerFooter(pi);
}
