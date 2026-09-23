import type { QuotaBucket } from "./client.ts";

/**
 * Gemini quota, grouped the way the backend pools it.
 *
 * `retrieveUserQuota` answers per runtime model id (`gemini-3.8-flash-high`,
 * `gemini-pro-agent`, `claude-opus-4-6-thinking`, …), but the ids of one
 * family draw on one shared allowance: every Flash variant reports the same
 * fraction and reset, as does every Pro variant. The window differs by plan —
 * a paid account resets weekly, a free one every five hours — so the bars are
 * labelled by family and the reset time says which window it is.
 */

export const GEMINI_QUOTA_FAMILIES = ["Flash", "Pro", "Claude", "GPT"] as const;
export type GeminiQuotaFamily = typeof GEMINI_QUOTA_FAMILIES[number];

/**
 * The family a public or runtime model id draws quota from. Undefined for ids
 * that are not agent models (tab completion, image, the `-lite` helpers the
 * client uses for commit messages and search), so they never skew a family.
 */
export function geminiQuotaFamily(modelId: string | undefined): GeminiQuotaFamily | undefined {
  const id = (modelId ?? "").toLowerCase();
  if (id.startsWith("claude-")) return "Claude";
  if (id.startsWith("gpt-oss")) return "GPT";
  if (!id.startsWith("gemini-") || /image|lite/.test(id)) return undefined;
  if (/(^|-)pro(-|$)/.test(id)) return "Pro";
  if (/(^|-)flash(-|$)/.test(id)) return "Flash";
  return undefined;
}

export interface GeminiFamilyQuota {
  family: GeminiQuotaFamily;
  /** Percent left, 0..100. */
  remaining: number;
  resetAt?: number;
}

/**
 * One figure per family: the most depleted bucket in it, so a variant that
 * has run dry is never hidden behind a sibling that has not.
 */
export function summarizeGeminiQuota(buckets: readonly QuotaBucket[]): GeminiFamilyQuota[] {
  const byFamily = new Map<GeminiQuotaFamily, GeminiFamilyQuota>();
  for (const bucket of buckets) {
    const family = geminiQuotaFamily(bucket.modelId);
    if (!family) continue;
    const remaining = bucket.remainingFraction * 100;
    const parsed = bucket.resetTime ? Date.parse(bucket.resetTime) : Number.NaN;
    const resetAt = Number.isFinite(parsed) ? parsed : undefined;
    const current = byFamily.get(family);
    const lower = !current || remaining < current.remaining;
    const sooner = current && remaining === current.remaining
      && resetAt !== undefined && (current.resetAt === undefined || resetAt < current.resetAt);
    if (lower || sooner) byFamily.set(family, { family, remaining, ...(resetAt !== undefined && { resetAt }) });
  }
  return GEMINI_QUOTA_FAMILIES.flatMap((family) => byFamily.get(family) ?? []);
}
