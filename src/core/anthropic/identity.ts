import { createHash } from "node:crypto";
import { CLAUDE_CODE_VERSION } from "./client-identity.ts";

/** Resolves the stable Claude account UUID exposed by the CLI bootstrap API. */

const resolved = new Map<string, string>();
const pending = new Map<string, Promise<string | undefined>>();

function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

/** Synchronous lookup for request routing; never starts network I/O. */
export function cachedAnthropicAccountIdentity(accessToken: string): string | undefined {
  return resolved.get(tokenKey(accessToken));
}

export async function anthropicAccountIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!accessToken.startsWith("sk-ant-oat")) return undefined;

  const key = tokenKey(accessToken);
  const cached = resolved.get(key);
  if (cached) return cached;
  const active = pending.get(key);
  if (active) return active;

  const request = (async () => {
    try {
      const response = await fetchImpl("https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli", {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return undefined;
      const body = await response.json() as any;
      const identity = body?.oauth_account?.account_uuid;
      if (typeof identity !== "string" || !identity) return undefined;
      resolved.set(key, identity);
      return identity;
    } catch {
      return undefined;
    }
  })().finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}
