import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  approve,
  checkModel,
  gatedProviders,
  isApproved,
  loadPolicy,
  providerState,
  revoke,
  toggleProvider,
} from "../../core/policy/policy.ts";
import { openProviderPicker, STATE_TEXT, type ProviderRow, type StateKey } from "./provider-picker.ts";

/**
 * Enforces the approval policy at the provider boundary, so it also covers
 * workflow subagents rather than relying on prompt instructions.
 */

class ModelPolicyError extends Error {
  code = "MODEL_POLICY_BLOCKED";
}

async function providerRows(ctx: any): Promise<ProviderRow[]> {
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
      state: providerState(provider) as ProviderRow["state"],
    };
  });
}

/**
 * Every provider the user actually has credentials for, plus any the policy
 * gates. Derived at call time so a newly authenticated provider shows up
 * without touching config.
 */
/**
 * Providers are free to decorate their own name. The CortexKit package calls
 * itself "Anthropic (CortexKit OAuth)". The implementation detail is noise in a
 * policy list, so the parenthetical is dropped.
 */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}


export function registerPolicyGate(pi: ExtensionAPI): void {
  let wrapped = false;

  const wrapProviders = (ctx: any) => {
    if (wrapped) return;
    for (const providerId of gatedProviders()) {
      const provider = ctx.modelRegistry.getProvider(providerId);
      if (!provider) continue;

      const guard = (model: any) => {
        const decision = checkModel(providerId, model?.id ?? "unknown");
        if (!decision.allowed) throw new ModelPolicyError(decision.message);
      };

      const originalStream = provider.stream?.bind(provider);
      const originalStreamSimple = provider.streamSimple?.bind(provider);

      pi.registerProvider({
        ...provider,
        ...(originalStream && {
          stream: (model: any, ...rest: any[]) => {
            guard(model);
            return originalStream(model, ...rest);
          },
        }),
        ...(originalStreamSimple && {
          streamSimple: (model: any, ...rest: any[]) => {
            guard(model);
            return originalStreamSimple(model, ...rest);
          },
        }),
      });
    }
    wrapped = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    loadPolicy();
    wrapProviders(ctx);
  });

  pi.registerCommand("provider", {
    description: "Toggle which providers may be used (approve | remove <name>)",
    getArgumentCompletions: (prefix) => {
      const [action, name = ""] = prefix.split(/\s+/);
      if (!prefix.includes(" ")) {
        return ["approve", "remove"]
          .filter((option) => option.startsWith(action))
          .map((option) => ({ value: option, label: option }));
      }
      if (action !== "approve" && action !== "remove") return [];
      return gatedProviders()
        .filter((provider) => provider.startsWith(name))
        .map((provider) => ({ value: `${action} ${provider}`, label: provider }));
    },
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const name = rest.join(" ");

      if (action === "approve" || action === "remove") {
        if (!name) {
          ctx.ui.notify(`Usage: /provider ${action} <provider>`, "warning");
          return;
        }
        if (!gatedProviders().includes(name)) {
          ctx.ui.notify(
            `“${name}” is not a gated provider. Gated: ${gatedProviders().join(", ") || "none"}`,
            "warning",
          );
          return;
        }
        if (action === "approve") approve(name);
        else revoke(name);
        ctx.ui.notify(`${name} is now ${isApproved(name) ? "approved" : "blocked"}.`, "info");
        return;
      }

      if (action) {
        ctx.ui.notify(`Unknown action “${action}”. Use: /provider [approve|remove <name>]`, "warning");
        return;
      }

      const rows = await providerRows(ctx);

      // Headless: plain text, no cursor to draw.
      if (!ctx.hasUI) {
        ctx.ui.notify(
          rows.map((row) => `${row.state === "auto" || row.state === "approved" ? "[on] " : "[off]"} ${row.display}: ${STATE_TEXT[row.state]}`).join("\n"),
          "info",
        );
        return;
      }

      await openProviderPicker(ctx, {
        rows: () => providerRows(ctx),
        toggle: (provider) => toggleProvider(provider) as StateKey,
      });
    },
  });
}
