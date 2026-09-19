/**
 * PKCE (RFC 7636) helpers.
 *
 * Provider-agnostic: nothing here knows about Anthropic. Any OAuth provider we
 * add later shares this file, and only its endpoints and scopes differ.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** 64 random bytes as the verifier, SHA-256 as the challenge. */
export async function generatePkce(): Promise<PkcePair> {
  const buffer = new Uint8Array(64);
  crypto.getRandomValues(buffer);
  const verifier = base64UrlEncode(buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)), method: "S256" };
}

/** Opaque anti-CSRF value echoed back by the authorization server. */
export function generateState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Accepts whatever the user pasted back: a full callback URL, a bare
 * `code#state` pair, or a raw query string. Returns undefined when none match.
 */
export function parseCallback(input: string): { code: string; state: string } | undefined {
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return { code, state };
  } catch {
    // Not a URL; fall through to the manual formats.
  }

  const [head, tail] = trimmed.split("#");
  if (head && tail) return { code: head, state: tail };

  const params = new URLSearchParams(trimmed);
  const code = params.get("code");
  const state = params.get("state");
  return code && state ? { code, state } : undefined;
}

const TRANSIENT_CODES = new Set([
  "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
]);

/** Worth retrying: a dropped connection rather than a rejected credential. */
export function isTransientNetworkError(error: unknown): boolean {
  const field = (name: string) =>
    error && typeof error === "object" && typeof (error as any)[name] === "string"
      ? (error as any)[name] as string
      : undefined;

  const code = field("code");
  if (code && TRANSIENT_CODES.has(code)) return true;

  const message = error instanceof Error ? error.message : (field("message") ?? String(error));
  if (message.includes("fetch failed")) return true;
  return [...TRANSIENT_CODES].some((candidate) => message.includes(candidate));
}

/** `Retry-After` as seconds, accepting both the numeric and HTTP-date forms. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  const delta = Math.ceil((date - Date.now()) / 1000);
  return delta > 0 ? delta : undefined;
}
