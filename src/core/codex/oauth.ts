import { generatePkce, generateState, parseCallback } from "../oauth/pkce.ts";

/**
 * Codex OAuth (ChatGPT account login).
 *
 * The client id is the public one the Codex CLI itself uses; it is not a
 * secret and the flow is PKCE precisely so that no secret is required. The
 * redirect is a loopback URL, which is what lets a CLI complete the flow.
 */

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

export interface CodexAuthStart {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export interface CodexTokens {
  access: string;
  refresh: string;
  expires: number;
}

/** Builds the authorization URL and the PKCE material needed to finish. */
export async function authorizeCodex(): Promise<CodexAuthStart> {
  const pkce = await generatePkce();
  const state = generateState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Forces the account chooser, which is the entire point when adding a
  // SECOND account: without it the browser silently reuses the existing
  // session and you get a duplicate of the account you already have.
  url.searchParams.set("prompt", "login");

  return { url: url.toString(), verifier: pkce.verifier, state, redirectUri: REDIRECT_URI };
}

/** Exchanges the callback URL (or a bare code) for tokens. */
export async function exchangeCodex(
  callback: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<CodexTokens> {
  const parsed = parseCallback(callback);
  const code = parsed?.code ?? callback.trim();
  if (!code) throw new Error("No authorization code found in the callback.");
  if (expectedState && parsed?.state && parsed.state !== expectedState) {
    throw new Error("OAuth state mismatch; the callback does not belong to this login attempt.");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Codex token exchange failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }

  const body: any = await response.json();
  if (!body?.access_token) throw new Error("Codex token exchange returned no access token.");
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
}

/** Refreshes an expiring token. */
export async function refreshCodexToken(refresh: string): Promise<CodexTokens> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
      scope: SCOPE,
    }),
  });

  if (!response.ok) {
    throw new Error(`Codex token refresh failed (${response.status}).`);
  }

  const body: any = await response.json();
  if (!body?.access_token) throw new Error("Codex token refresh returned no access token.");
  return {
    // OpenAI may omit a rotated refresh token; keeping the old one is correct.
    access: body.access_token,
    refresh: body.refresh_token ?? refresh,
    expires: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
}

/** A token good for at least a minute, refreshing and persisting if needed. */
export async function ensureCodexToken(
  account: { access?: string; refresh?: string; expires?: number },
  persist: (tokens: CodexTokens) => void,
): Promise<string | undefined> {
  if (account.access && typeof account.expires === "number" && Date.now() + 60_000 < account.expires) {
    return account.access;
  }
  if (!account.refresh) return account.access;
  const tokens = await refreshCodexToken(account.refresh);
  persist(tokens);
  return tokens.access;
}
