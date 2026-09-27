import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gatedProviders, loadPolicy, ProviderPolicy } from "./policy.ts";
import { withOpenRouterZdr } from "./openrouter/policy.ts";

/**
 * Enforces the approval policy at the provider boundary, so it also covers
 * workflow subagents rather than relying on prompt instructions.
 */

class ModelPolicyError extends Error {
  code = "MODEL_POLICY_BLOCKED";
}

// A workflow child inherits the host's live guard, not a second unapproved gate.
const POLICY_GUARD = Symbol.for("pi-plus.provider-policy");
interface PolicyGuard {
  base: Provider;
  active: boolean;
}

export function createPolicyGate(pi: ExtensionAPI): { policy: ProviderPolicy; needsRestart(): boolean } {
  const policy = new ProviderPolicy();
  const ownedGuards = new Set<PolicyGuard>();
  let needsRestart = false;

  const retireGuards = () => {
    policy.reset();
    for (const guard of ownedGuards) guard.active = false;
    ownedGuards.clear();
  };

  const wrapProviders = (ctx: any) => {
    // OpenRouter must be wrapped even when config auto-approves it: the picker
    // can still select ZDR (or Off) without changing the installed catalogue.
    for (const providerId of new Set([...gatedProviders(), "openrouter"])) {
      const previous: PolicyGuard | true | undefined = ctx.modelRegistry.getRegisteredNativeProvider?.(providerId)?.[POLICY_GUARD];
      // v1.0.23 did not retain the wrapped provider. Do not discard unknown
      // auth/compat wrappers trying to recover it during a hot upgrade.
      if (previous === true) { needsRestart = true; continue; }
      if (previous?.active) continue; // live guard inherited from a workflow parent
      const provider = previous?.base ?? ctx.modelRegistry.getProvider(providerId);
      if (!provider) continue;
      const ownership: PolicyGuard = { base: provider, active: true };

      const guard = (model: any) => {
        if (!ownership.active) throw new ModelPolicyError("Provider access expired after a session change. Open /provider to enable it again.");
        const decision = policy.checkModel(providerId, model?.id ?? "unknown");
        if (!decision.allowed) throw new ModelPolicyError(decision.message);
      };

      const wrapStream = (stream: any) => (model: any, context: any, options: any) => {
        guard(model);
        if (providerId === "openrouter" && policy.openRouterZdrRequired()) {
          const request = withOpenRouterZdr(model, options);
          return stream.call(provider, request.model, context, request.options);
        }
        return stream.call(provider, model, context, options);
      };
      const guarded = {
        ...provider,
        [POLICY_GUARD]: ownership,
        ...(provider.stream && { stream: wrapStream(provider.stream) }),
        ...(provider.streamSimple && { streamSimple: wrapStream(provider.streamSimple) }),
      };
      pi.registerProvider(guarded);
      ownedGuards.add(ownership);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    retireGuards();
    loadPolicy();
    wrapProviders(ctx);
  });
  pi.on("session_shutdown", retireGuards);

  return { policy, needsRestart: () => needsRestart };
}
