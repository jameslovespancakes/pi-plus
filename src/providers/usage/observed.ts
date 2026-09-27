import { sharedOAuthPoolStore } from "../shared/accounts/oauth-pool.ts";
import type { AccountQuotaState } from "../shared/accounts/routing.ts";
import { USAGE_FRESH_MS, type UsageRow } from "../shared/quota/pool.ts";
import { OBSERVED_PROVIDERS } from "./observed-providers.ts";

function observedRemaining(quota: AccountQuotaState, now: number): number | undefined {
  // A 429 reading means nothing once its block has cleared.
  if (quota.blockedUntil !== undefined) return quota.blockedUntil > now ? 0 : undefined;
  return quota.remainingPercent;
}

/**
 * What response headers last said for providers without a usage endpoint:
 * the account routing can still use most. A rate-limit reading, not a
 * subscription allowance, so it is labelled "rate" and dropped once old.
 */
export function observedRows(now = Date.now()): UsageRow[] {
  return OBSERVED_PROVIDERS.flatMap(([providerId, group]): UsageRow[] => {
    let quotas: AccountQuotaState[] = [];
    try {
      const store = sharedOAuthPoolStore(providerId);
      quotas = [
        store.primaryQuota(),
        ...store.load().accounts.filter((account) => account.enabled !== false).map((account) => account.quota),
      ].filter((quota): quota is AccountQuotaState => !!quota);
    } catch {
      return [];
    }

    const current = quotas.filter((quota) => observedRemaining(quota, now) !== undefined
      && ((quota.blockedUntil ?? 0) > now || now - quota.checkedAt < USAGE_FRESH_MS));
    if (current.length === 0) return [];
    const best = current.reduce((left, right) =>
      observedRemaining(right, now)! > observedRemaining(left, now)! ? right : left);
    const blocked = (best.blockedUntil ?? 0) > now;
    return [{
      group,
      label: "rate",
      remaining: observedRemaining(best, now)!,
      resetAt: blocked ? best.blockedUntil : best.resetAt,
      // A live block stays current until it clears, however old the reading.
      checkedAt: blocked ? now : best.checkedAt,
    }];
  });
}
