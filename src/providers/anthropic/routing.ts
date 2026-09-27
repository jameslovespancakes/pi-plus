import { quotaStateFromWindows, selectRoutingCandidate, type AccountQuotaState } from "../shared/accounts/routing.ts";
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
function scopedWindowsFor(quota: QuotaSnapshot, modelId: string): QuotaWindow[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = normalize(modelId);
  return (quota.scoped ?? []).filter((window) => {
    const name = normalize(window.id ?? "");
    return name && (id.includes(name) || name.includes(id)
      || (familyForModel(id) === "fable" && familyForModel(name) === "fable"));
  });
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

export function routingQuota(quota: QuotaSnapshot | undefined, family: Family, modelId?: string, now = Date.now()): AccountQuotaState | undefined {
  if (!quota) return undefined;
  const windows: (QuotaWindow | undefined)[] = [quota.five_hour, quota.seven_day];
  const scope = modelId ?? (family !== "general" ? family : undefined);
  if (scope) windows.push(...scopedWindowsFor(quota, scope));
  return quotaStateFromWindows(windows.filter((window): window is QuotaWindow => !!window).map((window) => {
    const at = Date.parse(window.resetsAt ?? "");
    return { remainingPercent: window.remainingPercent, resetAt: Number.isFinite(at) ? at : undefined };
  }), quota.checkedAt ?? now, now);
}

/** Picks an account using the shared sequential or quota-aware policy. */
export function selectAccount(input: SelectInput): Selection | undefined {
  const usable = input.candidates.filter((candidate) => candidate.access);
  if (usable.length === 0) return undefined;

  const selected = selectRoutingCandidate(
    usable.map((candidate) => ({
      id: candidate.id,
      order: candidate.order,
      lastUsed: candidate.lastUsed ?? candidate.account?.lastUsed ?? 0,
      quota: routingQuota(candidate.quota, input.family, input.modelId, input.now),
      value: candidate,
    })),
    input.mode,
    input.now,
  );
  return selected ? { candidate: selected.value, reason: usable.length === 1 ? "only" : input.mode } : undefined;
}


export { MAIN_ACCOUNT_ID };
