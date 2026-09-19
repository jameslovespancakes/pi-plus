import { generatePkce, generateState, isTransientNetworkError, parseCallback, parseRetryAfter } from "../oauth/pkce.ts";

/**
 * Anthropic OAuth: authorize, exchange, refresh.
 *
 * Extracted from @cortexkit/anthropic-auth-core so the auth path lives in this
 * repo rather than in a dependency we do not control. Token and storage shapes
 * stay byte-compatible with the existing files, so reverting to the vendored
 * package remains possible.
 *
 * The generic half of the flow (PKCE, state, callback parsing, retry
 * classification) lives in core/oauth and is shared with any future provider.
 */

/** Public OAuth client id for the Claude CLI. Not a secret. */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const AUTHORIZE_URLS = {
  console: "https://platform.claude.com/oauth/authorize",
  max: "https://claude.com/cai/oauth/authorize",
} as const;

export const CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/** The upstream client presents itself as axios; the token endpoint expects it. */
const TOKEN_USER_AGENT = "axios/1.15.2";

export const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

/** Refresh deliberately omits `org:create_api_key`. */
export const REFRESH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export type AuthorizeMode = keyof typeof AUTHORIZE_URLS;

export interface AuthorizeRequest {
  url: string;
  redirectUri: string;
  state: string;
  verifier: string;
}

export interface TokenSet {
  access: string;
  refresh: string;
  /** Absolute epoch ms. */
  expires: number;
}

const TOKEN_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  "User-Agent": TOKEN_USER_AGENT,
};

/** Step 1: the URL the user opens in a browser. */
export async function authorize(mode: AuthorizeMode = "max"): Promise<AuthorizeRequest> {
  const pkce = await generatePkce();
  const state = generateState();

  const url = new URL(AUTHORIZE_URLS[mode]);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CODE_CALLBACK_URL);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("state", state);

  return { url: url.toString(), redirectUri: CODE_CALLBACK_URL, state, verifier: pkce.verifier };
}

export type ExchangeResult =
  | ({ type: "success" } & TokenSet)
  | { type: "failed"; reason: string };

/** Step 2: trade the pasted callback for a token set. */
export async function exchange(
  pasted: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallback(pasted);
  if (!callback) return { type: "failed", reason: "could not read a code and state from that input" };
  // Guards against a callback from a different authorization attempt.
  if (expectedState && callback.state !== expectedState) {
    return { type: "failed", reason: "state did not match the request" };
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { type: "failed", reason: `token endpoint returned ${response.status} ${body.slice(0, 200)}` };
  }

  const json = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export class OAuthRefreshError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfter?: number;
  /**
   * Duck-typed marker rather than instanceof, so callers across module
   * instances still recognise it. Mirrors the upstream contract.
   */
  readonly isRefreshError = true;

  constructor(status: number, body: string, retryAfterHeader?: string | null) {
    super(`Anthropic OAuth refresh failed: ${status} ${body}`);
    this.name = "OAuthRefreshError";
    this.status = status;
    this.body = body;
    this.retryAfter = parseRetryAfter(retryAfterHeader);
  }
}

export interface RefreshOptions {
  refreshToken: string;
  maxRetries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Step 3: exchange a refresh token for a fresh access token.
 *
 * Retries 5xx and transient network failures with exponential backoff. A 4xx is
 * final: the credential itself was rejected, so retrying cannot help and would
 * only delay surfacing a re-auth prompt.
 */
export async function refreshToken(options: RefreshOptions): Promise<TokenSet> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((done) => setTimeout(done, baseDelayMs * 2 ** (attempt - 1)));
    }

    try {
      const response = await doFetch(TOKEN_URL, {
        method: "POST",
        headers: TOKEN_HEADERS,
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: options.refreshToken,
          client_id: CLIENT_ID,
          scope: REFRESH_SCOPE,
        }),
      });

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        const body = await response.text().catch(() => "");
        throw new OAuthRefreshError(response.status, body, response.headers.get("retry-after"));
      }

      const json = await response.json() as { access_token: string; refresh_token?: string; expires_in: number };
      const at = options.now?.() ?? Date.now();
      return {
        access: json.access_token,
        // Anthropic may omit a rotated refresh token; keep the existing one.
        refresh: json.refresh_token ?? options.refreshToken,
        expires: at + json.expires_in * 1000,
      };
    } catch (error) {
      if (error instanceof OAuthRefreshError) throw error;
      if (attempt < maxRetries && isTransientNetworkError(error)) continue;
      throw error;
    }
  }

  throw new Error("Token refresh exhausted all retries");
}
