import { anthropicAccountIdentity, cachedAnthropicAccountIdentity } from "./identity.ts";
import { primaryAccountEnabled } from "../shared/accounts/primary.ts";
import { loadAccounts, type Account as AnthropicAccount } from "./store.ts";
import { ensureAccessToken } from "./quota.ts";
import { readClaudeQuota } from "./usage-cache.ts";
import { USAGE_FRESH_MS, type UsageRow } from "../shared/quota/pool.ts";
import { readAuthFile, primaryOAuth, resetToMs, errorText, type SourceOptions } from "../shared/quota/source.ts";

/**
 * Builds usage rows from a stored quota snapshot.
 *
 * Snapshots are refreshed for free from response headers on every request, so
 * serving the HUD from them avoids touching `/api/oauth/usage` at all. That
 * endpoint rate limits aggressively, and /usage polling several accounts was a
 * reliable way to get 429s and then show nothing.
 *
 * Returns undefined when there is no snapshot yet, so the caller can fetch.
 */
function rowsFromSnapshot(group: string, quota: any): UsageRow[] | undefined {
  if (!quota) return undefined;
  const rows: UsageRow[] = [];
  const push = (label: string, window: any) => {
    if (typeof window?.remainingPercent !== "number") return;
    rows.push({
      group,
      label,
      remaining: window.remainingPercent,
      resetAt: resetToMs(window.resetsAt),
      // Required: pool.isFresh discards any row without it, which would make
      // every cached row pool as "n/a".
      checkedAt: window.checkedAt ?? quota.checkedAt,
      capacity: window.capacity,
      stale: Date.now() - (window.checkedAt ?? quota.checkedAt ?? 0) >= USAGE_FRESH_MS,
    });
  };
  push("5h", quota.five_hour);
  push("7d", quota.seven_day);
  push("Extra", quota.extra);
  for (const scoped of Array.isArray(quota.scoped) ? quota.scoped : []) {
    if (typeof scoped?.remainingPercent !== "number" || typeof scoped?.id !== "string" || !scoped.id) continue;
    // Snapshots written before the fix restate the 5h/7d windows as "scoped".
    if (scoped.id === "scoped") continue;
    push(`7d ${scoped.id.toLowerCase()}`, scoped);
  }
  return rows.length ? rows : undefined;
}

const claudeGroup = (account: AnthropicAccount) => `Claude ${account.label ?? account.id.slice(0, 8)}`;

export async function fetchClaudeRows(
  ctx: any,
  options: SourceOptions = {},
): Promise<{ rows: UsageRow[]; errors: string[]; groups: string[] }> {
  const read = options.readCredential ?? readAuthFile;
  const rows: UsageRow[] = [];
  const errors: string[] = [];
  const accounts: Array<{ group: string; token?: string; identity?: string; account?: AnthropicAccount }> = [];
  const groups = new Set<string>();

  let sidecars: AnthropicAccount[] = [];
  try {
    sidecars = (loadAccounts()?.accounts ?? []).filter((account) => account.type === "oauth" && account.enabled !== false);
  } catch (error) {
    errors.push(`Claude accounts: ${errorText(error)}`);
  }
  const taken = new Set(sidecars.map(claudeGroup));
  const primaryGroup = taken.has("Claude Personal") ? "Claude Primary" : "Claude Personal";

  try {
    const primary = await primaryOAuth(ctx, "anthropic", read);
    if (!primary) {
      if (!sidecars.length && primaryAccountEnabled("anthropic")) errors.push(`${primaryGroup}: not logged in`);
    } else {
      // pi's own login is often the same Claude account as a pooled one.
      // Counting it twice filed every window twice and marked the pool partial.
      const identity = cachedAnthropicAccountIdentity(primary.access)
        ?? await anthropicAccountIdentity(primary.access).catch(() => undefined);
      const twin = sidecars.find((account) => account.access === primary.access || (identity && account.identity === identity));
      if (!twin) {
        accounts.push({ group: primaryGroup, token: primary.access, identity });
        groups.add(primaryGroup);
      }
    }
  } catch (error) {
    // Logged in but unreadable: still an account the pool expects.
    groups.add(primaryGroup);
    errors.push(`${primaryGroup}: ${errorText(error)}`);
  }

  const seen = new Set<string>();
  for (const account of sidecars) {
    const key = account.identity ?? account.access ?? account.id;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ group: claudeGroup(account), account });
    groups.add(claudeGroup(account));
  }

  for (const entry of accounts) {
    try {
      const token = entry.token ?? (entry.account ? await ensureAccessToken(entry.account) : undefined);
      if (!token) {
        errors.push(`${entry.group}: no token`);
        continue;
      }
      const result = await readClaudeQuota({
        access: token, identity: entry.identity ?? entry.account?.identity,
        id: entry.account?.id, quota: entry.account?.quota,
      });
      rows.push(...(rowsFromSnapshot(entry.group, result.quota) ?? []));
      if (result.error) errors.push(`${entry.group}: ${result.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(/invalid_grant/i.test(message)
        ? `${entry.group}: login expired, run /accounts reauth anthropic ${entry.account?.label ?? entry.account?.id ?? ""}`.trim()
        : `${entry.group}: ${message}`);
    }
  }

  return { rows, errors, groups: [...groups] };
}
