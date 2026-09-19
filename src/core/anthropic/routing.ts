import { selectRoutingCandidate, type AccountQuotaState } from "../accounts/routing.ts";
import { MAIN_ACCOUNT_ID, type Account, type QuotaSnapshot, type QuotaWindow, type RoutingMode } from "./store.ts";

/** Claude quota normalization and account selection. */

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
  lastUsed?: number;
  account?: Account;
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

export interface SelectInput {
  candidates: Candidate[];
  family: Family;
  modelId?: string;
  mode: RoutingMode;
  now?: number;
}

export interface Selection {
  candidate: Candidate;
  reason: "quota-aware" | "sequential" | "only";
}

function routingQuota(candidate: Candidate, family: Family, modelId?: string): AccountQuotaState | undefined {
  const quota = candidate.quota;
  if (!quota) return undefined;
  const windows: (QuotaWindow | undefined)[] = [quota.five_hour, quota.seven_day];
  if (family === "fable") windows.push(scopedWindowFor(quota, modelId));
  const measured = windows.filter((window) => window && Number.isFinite(window.remainingPercent));
  if (measured.length === 0) return undefined;

  const remainingPercent = Math.min(...measured.map((window) => window!.remainingPercent!));
  const resetTimes = measured
    .filter((window) => (window!.remainingPercent ?? 0) <= 0 && window!.resetsAt)
    .map((window) => Date.parse(window!.resetsAt!))
    .filter(Number.isFinite);
  const resetAt = resetTimes.length > 0 ? Math.min(...resetTimes) : undefined;
  return {
    remainingPercent,
    resetAt,
    checkedAt: quota.checkedAt ?? Date.now(),
    blockedUntil: remainingPercent <= 0 ? resetAt ?? Number.POSITIVE_INFINITY : undefined,
  };
}

/** Picks an account using the shared sequential or quota-aware policy. */
export function selectAccount(input: SelectInput): Selection | undefined {
  const usable = input.candidates.filter((candidate) => candidate.access);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return { candidate: usable[0], reason: "only" };

  const selected = selectRoutingCandidate(
    usable.map((candidate) => ({
      id: candidate.id,
      order: candidate.order,
      lastUsed: candidate.lastUsed ?? candidate.account?.lastUsed ?? 0,
      quota: routingQuota(candidate, input.family, input.modelId),
      value: candidate,
    })),
    input.mode,
    input.now,
  );
  return selected ? { candidate: selected.value, reason: input.mode } : undefined;
}


export { MAIN_ACCOUNT_ID };
