import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { primaryAccountEnabled } from "../accounts/primary.ts";
import { agentPath, readJson } from "../../../core/store.ts";

export const TIMEOUT_MS = 10_000;

/** Reads a provider's credential as pi stores it (pi's `readStoredCredential`). */
export type CredentialReader = (providerId: string) => unknown;

export interface SourceOptions {
  /**
   * How the primary (pi-owned) credential is read. It must be read as stored:
   * `modelRegistry.getProviderAuth()` returns whatever account *routing*
   * picked, which can be a pooled one, so figures labelled as the primary
   * account could silently belong to another.
   */
  readCredential?: CredentialReader;
  signal?: AbortSignal;
}

/** Fallback when pi's reader was not supplied: the same file pi reads. */
export function readAuthFile(providerId: string): unknown {
  return readJson<Record<string, unknown>>(agentPath("auth.json"), {})[providerId];
}

export interface StoredOAuth {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export function usableOAuth(value: unknown, now = Date.now()): value is StoredOAuth {
  const credential = value as Partial<StoredOAuth> | undefined;
  return credential?.type === "oauth"
    && typeof credential.access === "string" && credential.access.length > 0
    && (typeof credential.expires !== "number" || credential.expires > now + 60_000);
}

/**
 * The provider's primary OAuth credential, or undefined when pi holds none
 * (not logged in, or an API key, which has no subscription quota).
 *
 * An expiring credential is refreshed by pi itself (`getProviderAuth`
 * refreshes and persists before it routes) and then read back, so rotating
 * refresh tokens are only ever spent by pi.
 */
export async function primaryOAuth(
  ctx: { modelRegistry?: Pick<ModelRegistry, "getProviderAuth"> } | undefined,
  providerId: string,
  read: CredentialReader,
): Promise<StoredOAuth | undefined> {
  if (!primaryAccountEnabled(providerId)) return undefined;
  const stored = read(providerId) as { type?: unknown } | undefined;
  if (stored?.type !== "oauth") return undefined;
  if (usableOAuth(stored)) return stored;

  try {
    // Extensions receive ModelRegistry, not ModelRuntime. This facade owns
    // the call to runtime.getAuth() and pi's refresh/locking/timeout policy.
    await ctx?.modelRegistry?.getProviderAuth(providerId);
  } catch (error) {
    // A rejected refresh token needs a new login, not automatic deletion.
    // Never echo a raw OAuth response into the HUD.
    if (/invalid_grant|refresh token expired/i.test(errorText(error))) {
      throw new Error(`login expired, run /login ${providerId}`, { cause: error });
    }
    throw error;
  }
  const refreshed = read(providerId);
  if (usableOAuth(refreshed)) return refreshed;
  throw new Error(`login expired, run /login ${providerId}`);
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function pct(value: unknown): number | undefined {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : undefined;
}

export function resetToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}
