import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accountProvider, routableProviders, type RoutingMode } from "../../core/accounts/registry.ts";

/**
 * `/routing [standard|optimal] [provider]`
 *
 *   standard  main account first, fall back only when exhausted
 *   optimal   balance across accounts by remaining quota and time to reset
 *
 * With no provider named, the mode is applied to every provider that supports
 * routing. With no mode, the current modes are reported.
 */

const MODES: RoutingMode[] = ["standard", "optimal"];

function isMode(value: string): value is RoutingMode {
  return (MODES as string[]).includes(value);
}

export function registerRoutingCommands(pi: ExtensionAPI): void {
  pi.registerCommand("routing", {
    description: "Account routing: standard (main first) or optimal (quota balanced)",
    getArgumentCompletions: (prefix) =>
      MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({
        value: mode,
        label: mode === "optimal" ? "optimal: balance by remaining quota" : "standard: main account first",
      })),
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
        ctx.ui.notify(`Usage: /routing [standard|optimal] [provider]`, "warning");
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
