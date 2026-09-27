import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPolicyGate } from "../../providers/policy-gate.ts";
import { gatedProviders, type ProviderPolicy } from "../../providers/policy.ts";
import { openProviderPicker, providerStateText, type ProviderRow } from "./provider-picker.ts";

/** Configured providers plus policy gates, re-read after authentication changes. */
async function providerRows(ctx: any, policy: ProviderPolicy): Promise<ProviderRow[]> {
  const ids = new Set<string>();
  try {
    for (const model of await ctx.modelRegistry.getAvailable()) ids.add(model.provider);
  } catch { /* registry unavailable */ }

  // The copy is deliberate: the body deletes from `ids` while iterating, which
  // is unsafe without it. oxlint cannot see the mutation below.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const id of [...ids]) {
    try {
      if (!ctx.modelRegistry.getProviderAuthStatus(id)?.configured) ids.delete(id);
    } catch { /* keep it if the status cannot be read */ }
  }

  // Gated providers stay listed without credentials so the policy stays visible.
  for (const id of gatedProviders()) ids.add(id);

  return [...ids].sort().map((provider) => {
    let display = provider;
    try {
      display = cleanName(ctx.modelRegistry.getProviderDisplayName(provider) || provider);
    } catch { /* fall back to the id */ }
    return {
      id: provider,
      provider,
      display,
      state: policy.providerState(provider),
    };
  });
}

/**
 * Providers are free to decorate their own name. The CortexKit package calls
 * itself "Anthropic (CortexKit OAuth)". The implementation detail is noise in a
 * policy list, so the parenthetical is dropped.
 */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}


export function registerPolicyGate(pi: ExtensionAPI): void {
  const { policy, needsRestart } = createPolicyGate(pi);

  pi.registerCommand("provider", {
    description: "Toggle providers (approve | remove <name>; zdr openrouter for ZDR-only routing)",
    getArgumentCompletions: (prefix) => {
      const [action, name = ""] = prefix.split(/\s+/);
      if (!prefix.includes(" ")) {
        return ["approve", "zdr", "remove"]
          .filter((option) => option.startsWith(action))
          .map((option) => ({ value: option, label: option }));
      }
      if (action !== "approve" && action !== "remove" && action !== "zdr") return [];
      return (action === "zdr" ? ["openrouter"] : [...new Set([...gatedProviders(), "openrouter"])])
        .filter((provider) => provider.startsWith(name))
        .map((provider) => ({ value: `${action} ${provider}`, label: provider }));
    },
    handler: async (args, ctx) => {
      if (needsRestart()) {
        ctx.ui.notify("Restart pi once to finish updating provider controls; /reload cannot update the old guard.", "warning");
        return;
      }
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const name = rest.join(" ");

      if (action === "approve" || action === "remove" || action === "zdr") {
        if (!name) {
          ctx.ui.notify(`Usage: /provider ${action} <provider>`, "warning");
          return;
        }
        if (action === "zdr" && name !== "openrouter") {
          ctx.ui.notify("ZDR mode is supported only for OpenRouter. Use: /provider zdr openrouter", "warning");
          return;
        }
        if (name !== "openrouter" && !gatedProviders().includes(name)) {
          ctx.ui.notify(
            `“${name}” is not a gated provider. Gated: ${gatedProviders().join(", ") || "none"}`,
            "warning",
          );
          return;
        }
        if (action === "zdr") policy.approveOpenRouterZdr();
        else if (action === "approve") policy.approve(name);
        else policy.revoke(name);
        ctx.ui.notify(`${name} is now ${providerStateText(name, policy.providerState(name))}.`, "info");
        return;
      }

      if (action) {
        ctx.ui.notify(`Unknown action “${action}”. Use: /provider [approve|remove <name>] or /provider zdr openrouter`, "warning");
        return;
      }

      const rows = await providerRows(ctx, policy);

      // Headless: plain text, no cursor to draw.
      if (!ctx.hasUI) {
        ctx.ui.notify(
          rows.map((row) => `${row.state === "blocked" || row.state === "denied" ? "[off]" : "[on] "} ${row.display}: ${providerStateText(row.provider, row.state)}`).join("\n"),
          "info",
        );
        return;
      }

      await openProviderPicker(ctx, {
        rows: () => providerRows(ctx, policy),
        toggle: (provider) => policy.toggleProvider(provider),
      });
    },
  });
}
