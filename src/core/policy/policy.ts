import { readConfig, updateConfig } from "../config.ts";

/**
 * Approval policy for model selection.
 *
 * Subscription providers are free to use. Metered providers (OpenRouter and
 * anything else that bills per token) require an explicit approval before a
 * request is allowed to leave the machine.
 */

export interface PolicyFile {
  autoApprove: string[];
  requireApproval: string[];
  deny: string[];
}

const DEFAULT_POLICY: PolicyFile = {
  autoApprove: ["anthropic/*", "openai-codex/*"],
  requireApproval: ["openrouter/*", "google/*", "openai/*", "xai/*"],
  deny: [],
};

export type Decision =
  | { allowed: true; reason: "auto" | "approved" }
  | { allowed: false; reason: "denied" | "needs-approval"; message: string };

const approvals = new Map<string, number>();

export function loadPolicy(): PolicyFile {
  return readConfig().policy;
}

export function savePolicy(next: PolicyFile): void {
  updateConfig((config) => {
    config.policy = {
      autoApprove: next.autoApprove ?? DEFAULT_POLICY.autoApprove,
      requireApproval: next.requireApproval ?? DEFAULT_POLICY.requireApproval,
      deny: next.deny ?? DEFAULT_POLICY.deny,
    };
  });
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matches(pattern, value));
}

/**
 * Provider ids that require approval, derived from the policy patterns so the
 * toggle list always reflects the configured file rather than a hardcoded set.
 */
export function gatedProviders(): string[] {
  const names = loadPolicy().requireApproval
    .map((pattern) => pattern.split("/")[0])
    .filter((name) => name && !name.includes("*"));
  return [...new Set(names)].sort();
}

export type ProviderState = "auto" | "approved" | "blocked" | "denied";

/** How the policy currently treats a provider, for display and toggling. */
export function providerState(provider: string): ProviderState {
  const current = loadPolicy();
  if (matchesAny(current.deny, `${provider}/*`) || matchesAny(current.deny, provider)) return "denied";
  if (matchesAny(current.requireApproval, `${provider}/*`)) {
    return isApproved(provider) ? "approved" : "blocked";
  }
  return "auto";
}

/**
 * Flips whether a provider may be used.
 *
 * Auto-approved providers are moved into `requireApproval` so the switch is
 * reversible; gated ones just gain or lose their session grant. Denied
 * providers are left alone; `deny` is an explicit, deliberate block.
 */
export function toggleProvider(provider: string): ProviderState {
  const state = providerState(provider);
  if (state === "denied") return state;

  if (state === "auto") {
    const current = loadPolicy();
    savePolicy({
      ...current,
      autoApprove: current.autoApprove.filter((pattern) => !matches(pattern, `${provider}/*`) && pattern !== `${provider}/*`),
      requireApproval: [...new Set([...current.requireApproval, `${provider}/*`])],
    });
    revoke(provider);
    return "blocked";
  }

  if (state === "approved") {
    revoke(provider);
    return "blocked";
  }

  approve(provider);
  return "approved";
}

/** Grant approval for a provider until `untilMs` (omitted means this session). */
export function approve(provider: string, durationMs?: number): void {
  approvals.set(provider, durationMs ? Date.now() + durationMs : Number.MAX_SAFE_INTEGER);
}

export function revoke(provider: string): void {
  approvals.delete(provider);
}

export function isApproved(provider: string): boolean {
  const until = approvals.get(provider);
  return until !== undefined && Date.now() < until;
}

/** Flips a provider's approval and reports the resulting state. */
export function toggleApproval(provider: string): boolean {
  if (isApproved(provider)) {
    revoke(provider);
    return false;
  }
  approve(provider);
  return true;
}

export interface ProviderApproval {
  provider: string;
  approved: boolean;
  until?: number;
}

/** Current approval state for every gated provider, for display. */
export function approvalStates(): ProviderApproval[] {
  return gatedProviders().map((provider) => {
    const until = approvals.get(provider);
    const approved = until !== undefined && Date.now() < until;
    return { provider, approved, until: approved && until !== Number.MAX_SAFE_INTEGER ? until : undefined };
  });
}

export function checkModel(provider: string, modelId: string): Decision {
  const current = loadPolicy();
  const ref = `${provider}/${modelId}`;

  if (matchesAny(current.deny, ref) || matchesAny(current.deny, `${provider}/*`)) {
    return { allowed: false, reason: "denied", message: `${ref} is denied by model policy.` };
  }
  if (matchesAny(current.autoApprove, ref)) return { allowed: true, reason: "auto" };

  const gated = matchesAny(current.requireApproval, ref);
  if (!gated) return { allowed: true, reason: "auto" };

  if (!isApproved(provider)) {
    return {
      allowed: false,
      reason: "needs-approval",
      message:
        `${ref} is a metered (pay-per-token) model and is not approved in this session. `
        + `Use a subscription model such as anthropic/* or openai-codex/*, or ask the user to run `
        + `/provider approve ${provider}.`,
    };
  }

  return { allowed: true, reason: "approved" };
}

export function policySummary(): string {
  const current = loadPolicy();
  const active = approvalStates()
    .filter((entry) => entry.approved)
    .map((entry) => `${entry.provider}${entry.until ? ` (until ${new Date(entry.until).toLocaleTimeString()})` : " (session)"}`);
  return [
    "Model approval policy",
    `  auto-approved:    ${current.autoApprove.join(", ") || "none"}`,
    `  needs approval:   ${current.requireApproval.join(", ") || "none"}`,
    `  denied:           ${current.deny.join(", ") || "none"}`,
    `  approved now:     ${active.join(", ") || "none"}`,
  ].join("\n");
}
