import { MAIN_ACCOUNT_ID, type Account, type QuotaSnapshot, type QuotaWindow, type RoutingMode } from "./store.ts";

/**
 * Account selection and sticky session assignment.
 *
 * Two jobs:
 *   1. score each candidate by how much work it can absorb
 *   2. keep a session on one account, because Anthropic's prompt cache is
 *      per-account and migrating throws it away
 */

/** How long each window takes to refill completely. */
export const WINDOW_HOURS = { five_hour: 5, seven_day: 168, scoped: 168 } as const;
export type WindowKey = keyof typeof WINDOW_HOURS;

export type Family = "fable" | "opus" | "general";

export function familyForModel(model: string | undefined): Family {
  const id = (model ?? "").toLowerCase();
  if (id.includes("fable") || id.includes("mythos")) return "fable";
  if (id.includes("opus")) return "opus";
  return "general";
}

export interface Candidate {
  id: string;
  access?: string;
  quota?: QuotaSnapshot;
  /** Config order; `main` is 0, so it wins ties. */
  order: number;
  account?: Account;
}

/**
 * Hours of wall-clock recovery per point of quota spent.
 *
 * Expressed against the window's own length rather than its distance to reset:
 * a 5h window regenerates 34x faster than a 7d one, so a point spent there is
 * far cheaper. Returns Infinity at or below zero, which collapses the account's
 * weight to 0 and removes it from selection.
 */
export function recoveryCost(window: QuotaWindow | undefined, key: WindowKey, reserve = 0): number {
  const remaining = window?.remainingPercent;
  if (!Number.isFinite(remaining)) return Infinity;
  const spendable = Math.max(0, (remaining as number) - reserve);
  if (spendable <= 0) return Infinity;
  return WINDOW_HOURS[key] / spendable;
}

/** Scoped windows are model-specific; match the one governing this model. */
export function scopedWindowFor(quota: QuotaSnapshot | undefined, modelId?: string): QuotaWindow | undefined {
  const scoped = quota?.scoped;
  if (!Array.isArray(scoped) || scoped.length === 0) return undefined;
  if (!modelId) return scoped[0];
  const id = modelId.toLowerCase();
  return scoped.find((w) => {
    const name = String((w as any).id ?? (w as any).scope?.model?.display_name ?? "").toLowerCase();
    return name && (id.includes(name) || name.includes(id));
  }) ?? scoped[0];
}

/**
 * Capacity score. Higher is better, 0 means unusable.
 *
 * Costs are summed and inverted rather than taking the minimum window, so a
 * cheap fast-refilling window still contributes instead of being masked by a
 * slow one. Any window at zero yields Infinity and zeroes the account, which
 * preserves the hard exclusion rule.
 */
export function candidateWeight(candidate: Candidate, family: Family, modelId?: string, reserve = 0): number {
  const quota = candidate.quota;
  if (!quota) return 0;

  const costs = [
    recoveryCost(quota.five_hour, "five_hour", reserve),
    recoveryCost(quota.seven_day, "seven_day", reserve),
  ];

  // Fable requests are additionally gated by their scoped window.
  if (family === "fable") {
    const scoped = scopedWindowFor(quota, modelId);
    if (scoped) costs.push(recoveryCost(scoped, "scoped", reserve));
  }

  const total = costs.reduce((sum, c) => sum + c, 0);
  return Number.isFinite(total) && total > 0 ? 1 / total : 0;
}

export interface Assignment {
  accountId: string;
  family: Family;
  assignedAt: number;
  lastSeenAt: number;
}

export interface SelectInput {
  candidates: Candidate[];
  family: Family;
  modelId?: string;
  mode: RoutingMode;
  /** Existing sticky assignment for this session, if any. */
  assignment?: Assignment;
  now?: number;
}

export interface Selection {
  candidate: Candidate;
  reason: "sticky" | "weighted" | "main-first" | "fallback-first" | "only";
}

/**
 * Picks an account.
 *
 * `main-first` and `fallback-first` are simple orderings. `sticky-balanced`
 * keeps the session where it is while that account is still viable, and
 * otherwise takes the highest-weight candidate.
 */
export function selectAccount(input: SelectInput): Selection | undefined {
  const usable = input.candidates.filter((c) => c.access);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return { candidate: usable[0], reason: "only" };

  if (input.mode === "main-first" || input.mode === "fallback-first") {
    const ordered = [...usable].sort((a, b) =>
      input.mode === "main-first" ? a.order - b.order : b.order - a.order);
    const viable = ordered.find((c) => candidateWeight(c, input.family, input.modelId) > 0);
    return viable ? { candidate: viable, reason: input.mode } : undefined;
  }

  const weighted = usable
    .map((candidate) => ({ candidate, weight: candidateWeight(candidate, input.family, input.modelId) }))
    .filter((entry) => entry.weight > 0);
  if (weighted.length === 0) return undefined;

  // Stay put while the assigned account can still serve: migrating discards
  // the prompt cache, which costs more than a slightly better weight gains.
  if (input.assignment) {
    const held = weighted.find((e) => e.candidate.id === input.assignment!.accountId);
    if (held) return { candidate: held.candidate, reason: "sticky" };
  }

  weighted.sort((a, b) =>
    b.weight - a.weight
    || a.candidate.order - b.candidate.order
    || a.candidate.id.localeCompare(b.candidate.id));
  return { candidate: weighted[0].candidate, reason: "weighted" };
}

/** Seconds until the soonest window that would unblock this model resets. */
export function retryAfterSeconds(candidates: Candidate[], family: Family, modelId?: string, now = Date.now()): number {
  const resets: number[] = [];
  for (const candidate of candidates) {
    const quota = candidate.quota;
    if (!quota) continue;
    const windows: (QuotaWindow | undefined)[] = [quota.five_hour, quota.seven_day];
    if (family === "fable") windows.push(scopedWindowFor(quota, modelId));
    for (const w of windows) {
      if (!w?.resetsAt) continue;
      if ((w.remainingPercent ?? 0) > 0) continue;
      const at = Date.parse(w.resetsAt);
      if (Number.isFinite(at) && at > now) resets.push(at);
    }
  }
  if (resets.length === 0) return 60;
  return Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000));
}

export { MAIN_ACCOUNT_ID };
