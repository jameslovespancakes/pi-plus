import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accountProvider, routableProviders, type RoutingMode } from "../../core/accounts/registry.ts";

/**
 * `/routing [sequential|quota-aware] [provider]`
 *
 *   sequential   account 1, then account 2 when the first is exhausted
 *   quota-aware  use the account with the most remaining capacity
 *
 * With no provider named, the mode is applied to every provider that supports
 * routing. With no mode, the current modes are reported.
 */

const MODES: RoutingMode[] = ["sequential", "quota-aware"];

function isMode(value: string): value is RoutingMode {
  return (MODES as string[]).includes(value);
}

export function registerRoutingCommands(pi: ExtensionAPI): void {
  pi.registerCommand("routing", {
    description: "Account routing: sequential or quota-aware",
    getArgumentCompletions: (prefix) => {
      const [mode, providerPrefix = ""] = prefix.trim().split(/\s+/, 2);
      if (!/\s/.test(prefix)) {
        return MODES.filter((candidate) => candidate.startsWith(mode ?? "")).map((candidate) => ({
          value: candidate,
          label: candidate === "quota-aware" ? "quota-aware: use remaining capacity" : "sequential: account 1, then 2",
        }));
      }
      if (!mode || !isMode(mode)) return [];
      return routableProviders()
        .filter((provider) => provider.id.startsWith(providerPrefix))
        .map((provider) => ({ value: `${mode} ${provider.id}`, label: provider.id }));
    },
    handler: async (args, ctx) => {
      const [first, second] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const providers = second ? [accountProvider(second)].filter((entry) => !!entry) : routableProviders();

      if (providers.length === 0) {
        ctx.ui.notify(
          second ? `“${second}” does not support account routing.` : "No providers support account routing.",
          "warning",
        );
        return;
      }

      // No mode given: report current state.
      if (!first) {
        const lines: string[] = [];
        for (const provider of providers) {
          try {
            const mode = await provider.routing!.get();
            lines.push(`${provider.label} (${provider.id}): ${mode}`, `  ${provider.routing!.describe(mode)}`);
          } catch (error) {
            lines.push(`${provider.label}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (!isMode(first)) {
        ctx.ui.notify(`Usage: /routing [sequential|quota-aware] [provider]`, "warning");
        return;
      }

      const results: string[] = [];
      for (const provider of providers) {
        try {
          const mode = await provider.routing!.set(first);
          results.push(`${provider.label}: ${mode}`, `  ${provider.routing!.describe(mode)}`);
        } catch (error) {
          results.push(`${provider.label}: failed, ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      ctx.ui.notify(results.join("\n"), "info");
    },
  });
}
