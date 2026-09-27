import { loadOAuthPool, saveOAuthAccount, type PooledOAuthAccount } from "../shared/accounts/oauth-pool.ts";
import { refreshAbortSignal } from "../shared/accounts/routing.ts";
import { fetchUserQuota, GeminiVerificationRequiredError } from "./client.ts";
import { credentialEmail } from "./credentials.ts";
import { geminiOAuth, requestProjectId } from "./oauth.ts";
import { summarizeGeminiQuota } from "./quota.ts";
import type { UsageRow } from "../shared/quota/pool.ts";
import { primaryOAuth, readAuthFile, errorText, TIMEOUT_MS, type StoredOAuth, type SourceOptions } from "../shared/quota/source.ts";

const GEMINI = "gemini";
const GEMINI_PRIMARY_GROUP = "Gemini Primary";

/** A pooled Gemini account with a live token, refreshed and saved if it had lapsed. */
async function freshGeminiAccount(account: PooledOAuthAccount): Promise<PooledOAuthAccount> {
  if (account.expires > Date.now() + 60_000) return account;
  // Google does not rotate refresh tokens on use, so a refresh racing the
  // serving path's own is harmless: both tokens stay valid.
  const credential = await geminiOAuth.refresh(account, refreshAbortSignal());
  const updated = { ...account, ...credential };
  saveOAuthAccount(GEMINI, updated);
  return updated;
}

/**
 * Gemini quota per account from `retrieveUserQuota`, one row per model
 * family (Flash, Pro, Claude, GPT). Silent when no Gemini account exists.
 */
export async function fetchGeminiRows(
  ctx: any,
  options: SourceOptions = {},
): Promise<{ rows: UsageRow[]; errors: string[]; groups: string[] }> {
  const errors: string[] = [];
  const accounts: Array<{ group: string; credential?: StoredOAuth; account?: PooledOAuthAccount }> = [];
  const groups: string[] = [];
  const emails = new Set<string>();

  try {
    const primary = await primaryOAuth(ctx, GEMINI, options.readCredential ?? readAuthFile);
    if (primary) {
      accounts.push({ group: GEMINI_PRIMARY_GROUP, credential: primary });
      const email = credentialEmail(primary as any);
      if (email) emails.add(email.toLowerCase());
    }
  } catch (error) {
    groups.push(GEMINI_PRIMARY_GROUP);
    errors.push(`${GEMINI_PRIMARY_GROUP}: ${errorText(error)}`);
  }

  try {
    for (const account of loadOAuthPool(GEMINI).accounts) {
      if (account.enabled === false || !account.access) continue;
      // The same Google account signed in twice has one allowance, not two.
      const email = credentialEmail(account)?.toLowerCase();
      if (email && emails.has(email)) continue;
      if (email) emails.add(email);
      let group = `Gemini ${account.label || email || account.id.slice(0, 8)}`;
      if (accounts.some((entry) => entry.group === group)) group = `${group} ${account.id.slice(0, 4)}`;
      accounts.push({ group, account });
    }
  } catch (error) {
    errors.push(`Gemini accounts: ${errorText(error)}`);
  }

  const results = await Promise.all(accounts.map(async (entry): Promise<{ rows: UsageRow[]; error?: string }> => {
    try {
      const credential = entry.account ? await freshGeminiAccount(entry.account) : entry.credential!;
      const buckets = await fetchUserQuota(
        credential.access,
        requestProjectId(credential as any),
        AbortSignal.timeout(TIMEOUT_MS),
      );
      const checkedAt = Date.now();
      const rows = summarizeGeminiQuota(buckets).map((family): UsageRow => ({
        group: entry.group,
        label: family.family,
        remaining: family.remaining,
        resetAt: family.resetAt,
        checkedAt,
      }));
      return rows.length ? { rows } : { rows, error: `${entry.group}: quota unavailable` };
    } catch (error) {
      const message = errorText(error);
      const reauth = entry.account ? `/accounts reauth gemini ${entry.account.label || entry.account.id}` : "/login gemini";
      return {
        rows: [],
        error: error instanceof GeminiVerificationRequiredError
          ? `${entry.group}: Google account verification required; run ${reauth} to complete verification.`
          : /invalid_grant/i.test(message)
            ? `${entry.group}: login expired, run ${reauth}`
            : `${entry.group}: ${message}`,
      };
    }
  }));

  return {
    rows: results.flatMap((result) => result.rows),
    errors: [...errors, ...results.flatMap((result) => result.error ?? [])],
    groups: [...groups, ...accounts.map((entry) => entry.group)],
  };
}
