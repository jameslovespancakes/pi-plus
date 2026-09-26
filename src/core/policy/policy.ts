import { readConfig, updateConfig } from "../config.ts";

export interface PolicyFile {
  autoApprove: string[];
  requireApproval: string[];
  deny: string[];
}

export type Decision =
  | { allowed: true; reason: "auto" | "approved" }
  | { allowed: false; reason: "denied" | "needs-approval"; message: string };

export type ProviderState = "auto" | "approved" | "blocked" | "denied" | "zdr";

export interface ProviderApproval {
  provider: string;
  approved: boolean;
  until?: number;
}

export function loadPolicy(): PolicyFile {
  return readConfig().policy;
}

export function savePolicy(next: PolicyFile): void {
  updateConfig((config) => { config.policy = next; });
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matches(pattern, value));
}

/** Configured approval gates, independent of a session's live grants. */
export function gatedProviders(): string[] {
  const names = loadPolicy().requireApproval.map((pattern) => pattern.split("/")[0])
    .filter((name) => name && !name.includes("*"));
  return [...new Set(names)].sort();
}

/** Runtime grants belong to an extension session, never a shared module or config file. */
export class ProviderPolicy {
  private readonly approvals = new Map<string, number>();
  private openRouterMode: "off" | "on" | "zdr" | undefined;

  reset(): void {
    this.approvals.clear();
    this.openRouterMode = undefined;
  }

  openRouterZdrRequired(): boolean {
    return this.openRouterMode === "zdr";
  }

  approveOpenRouterZdr(): void {
    this.approve("openrouter");
    this.openRouterMode = "zdr";
  }

  /** No duration means a grant for this session only. */
  approve(provider: string, durationMs?: number): void {
    this.approvals.set(provider, durationMs ? Date.now() + durationMs : Number.MAX_SAFE_INTEGER);
    if (provider === "openrouter") this.openRouterMode = "on";
  }

  revoke(provider: string): void {
    this.approvals.delete(provider);
    if (provider === "openrouter") this.openRouterMode = "off";
  }

  isApproved(provider: string): boolean {
    const until = this.approvals.get(provider);
    return until !== undefined && Date.now() < until;
  }

  providerState(provider: string): ProviderState {
    const current = loadPolicy();
    if (matchesAny(current.deny, `${provider}/*`) || matchesAny(current.deny, provider)) return "denied";
    if (provider === "openrouter" && this.openRouterMode !== undefined) {
      return this.isApproved(provider) ? (this.openRouterZdrRequired() ? "zdr" : "approved") : "blocked";
    }
    if (matchesAny(current.requireApproval, `${provider}/*`)) {
      return this.isApproved(provider) ? "approved" : "blocked";
    }
    return "auto";
  }

  /** Only OpenRouter cycles through a third (ZDR-only) state. */
  toggleProvider(provider: string): ProviderState {
    const state = this.providerState(provider);
    if (state === "denied") return state;
    if (provider === "openrouter") {
      if (state === "auto" || state === "approved") this.approveOpenRouterZdr();
      else if (state === "zdr") this.revoke(provider);
      else this.approve(provider);
      return this.providerState(provider);
    }
    if (state === "auto") {
      const current = loadPolicy();
      savePolicy({
        ...current,
        autoApprove: current.autoApprove.filter((pattern) => !matches(pattern, `${provider}/*`)),
        requireApproval: [...new Set([...current.requireApproval, `${provider}/*`])],
      });
      this.revoke(provider);
      return "blocked";
    }
    return this.toggleApproval(provider) ? "approved" : "blocked";
  }

  toggleApproval(provider: string): boolean {
    if (this.isApproved(provider)) { this.revoke(provider); return false; }
    this.approve(provider);
    return true;
  }

  approvalStates(): ProviderApproval[] {
    const ids = new Set([...gatedProviders(), ...this.approvals.keys()]);
    return [...ids].sort().map((provider) => {
      const until = this.approvals.get(provider);
      const approved = this.isApproved(provider);
      return { provider, approved, until: approved && until !== Number.MAX_SAFE_INTEGER ? until : undefined };
    });
  }

  checkModel(provider: string, modelId: string): Decision {
    const current = loadPolicy();
    const ref = `${provider}/${modelId}`;
    if (matchesAny(current.deny, ref) || matchesAny(current.deny, `${provider}/*`) || matchesAny(current.deny, provider)) {
      return { allowed: false, reason: "denied", message: `${ref} is denied by model policy.` };
    }
    // Explicit OpenRouter Off must override even an auto-approve wildcard.
    const explicitOpenRouterMode = provider === "openrouter" && this.openRouterMode !== undefined;
    if (!explicitOpenRouterMode && matchesAny(current.autoApprove, ref)) return { allowed: true, reason: "auto" };
    if (!explicitOpenRouterMode && !matchesAny(current.requireApproval, ref)) return { allowed: true, reason: "auto" };
    if (!this.isApproved(provider)) {
      return {
        allowed: false, reason: "needs-approval",
        message: `${ref} is a metered (pay-per-token) model and is not approved in this session. `
          + "Use a subscription model such as anthropic/* or openai-codex/*, or ask the user to run "
          + `/provider approve ${provider}.`,
      };
    }
    return { allowed: true, reason: "approved" };
  }

  policySummary(): string {
    const current = loadPolicy();
    const active = this.approvalStates().filter((entry) => entry.approved).map((entry) =>
      `${entry.provider}${entry.provider === "openrouter" && this.openRouterZdrRequired() ? " (ZDR)" : ""}`
      + (entry.until ? ` (until ${new Date(entry.until).toLocaleTimeString()})` : " (session)"));
    return [
      "Model approval policy",
      `  auto-approved:    ${current.autoApprove.join(", ") || "none"}`,
      `  needs approval:   ${current.requireApproval.join(", ") || "none"}`,
      `  denied:           ${current.deny.join(", ") || "none"}`,
      `  approved now:     ${active.join(", ") || "none"}`,
    ].join("\n");
  }
}
