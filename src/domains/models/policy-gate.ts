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
  type ProviderState,
} from "../../core/policy/policy.ts";

/**
 * Enforces the approval policy at the provider boundary, so it also covers
 * workflow subagents rather than relying on prompt instructions.
 */

class ModelPolicyError extends Error {
  code = "MODEL_POLICY_BLOCKED";
}

const LABEL: Record<ProviderState, string> = {
  auto: "always allowed",
  approved: "approved this session",
  blocked: "needs approval",
  denied: "denied in policy",
};

function renderRow(entry: { provider: string; display: string; state: ProviderState }, width: number): string {
  const mark = entry.state === "auto" || entry.state === "approved" ? "✓" : " ";
  return `[${mark}] ${entry.display.padEnd(width)}  ${LABEL[entry.state]}`;
}

/**
 * Every provider the user actually has credentials for, plus any the policy
 * gates. Derived at call time so a newly authenticated provider shows up
 * without touching config.
 */
/**
 * Providers are free to decorate their own name — the CortexKit package calls
 * itself "Anthropic (CortexKit OAuth)". The implementation detail is noise in a
 * policy list, so the parenthetical is dropped.
 */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}

async function listProviders(ctx: any): Promise<{ provider: string; display: string; state: ProviderState }[]> {
  const ids = new Set<string>();

  try {
    for (const model of await ctx.modelRegistry.getAvailable()) ids.add(model.provider);
  } catch { /* registry unavailable */ }

  for (const id of [...ids]) {
    try {
      if (!ctx.modelRegistry.getProviderAuthStatus(id)?.configured) ids.delete(id);
    } catch { /* keep it if the status cannot be read */ }
  }

  // Gated providers stay listed even with no credentials, so the policy is visible.
  for (const id of gatedProviders()) ids.add(id);

  return [...ids].sort().map((provider) => ({
    provider,
    display: (() => {
      try {
        return cleanName(ctx.modelRegistry.getProviderDisplayName(provider) || provider);
      } catch {
        return provider;
      }
    })(),
    state: providerState(provider),
  }));
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

      // Bare /provider: the toggle picker.
      const initial = await listProviders(ctx);
      if (!ctx.hasUI) {
        ctx.ui.notify(
          initial.map((entry) => `${entry.state === "blocked" || entry.state === "denied" ? "[ ]" : "[✓]"} ${entry.display} — ${LABEL[entry.state]}`).join("\n"),
          "info",
        );
        return;
      }

      // Stay open so several providers can be toggled in one visit; ui.select
      // resolves to undefined on escape, which ends the loop.
      for (;;) {
        const entries = await listProviders(ctx);
        if (entries.length === 0) {
          ctx.ui.notify("No providers are configured. Sign in with /account or pi auth.", "info");
          return;
        }

        const width = Math.max(...entries.map((entry) => entry.display.length));
        const rows = entries.map((entry) => renderRow(entry, width));
        const choice = await ctx.ui.select("Providers — enter toggles, esc closes", rows);
        if (!choice) return;

        const target = entries[rows.indexOf(choice)];
        if (!target) return;
        if (target.state === "denied") {
          ctx.ui.notify(`${target.display} is denied in policy. Edit pi-plus.json to change that.`, "warning");
          continue;
        }
        toggleProvider(target.provider);
      }
    },
  });
}
