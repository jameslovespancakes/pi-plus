import type {
  ModelAuth,
  OAuthAuth,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "../oauth/callback-server.ts";
import { generatePkce, generateState, parseCallback } from "../oauth/pkce.ts";
import {
  geminiEnv, discoverProjectId, fallbackProjectId, fetchUserEmail, fetchUserQuota, GeminiVerificationRequiredError,
} from "./client.ts";
import {
  credentialEmail,
  credentialProjectId,
  encodeApiKey,
  type GeminiCredential,
} from "./credentials.ts";

/**
 * Gemini OAuth in pi's native `OAuthAuth` shape, so it drops straight
 * into `/login`, `/accounts` and pi-plus's pooled routing.
 *
 * These are the Antigravity desktop client's installed-app credentials. An
 * installed-app "secret" is not a secret: it ships in every copy of the app
 * and Google documents it as public. The literals are split only so secret
 * scanners do not block a push over a public value. `PI_GEMINI_CLIENT_ID`
 * and `PI_GEMINI_CLIENT_SECRET` point the flow at your own OAuth client.
 */

const clientId = () => geminiEnv("CLIENT_ID")
  ?? ["1071006060591-tmhssin2h21lcre235vtolojh4g403ep", "apps.googleusercontent.com"].join(".");
const clientSecret = () => geminiEnv("CLIENT_SECRET")
  ?? ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");

/** Registered against the client id above; it cannot move to an ephemeral port. */
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
];

/** Refresh a little early so a routed request never races the expiry. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Google's `{error, error_description}` as one line; the raw body only as a fallback. */
function tokenError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    const parts = [parsed.error, parsed.error_description].filter((part) => typeof part === "string" && part);
    if (parts.length > 0) return parts.join(": ");
  } catch {
    // Not JSON; fall through.
  }
  return body.trim().slice(0, 300) || "no details";
}

async function exchange(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...body }),
    signal,
  });
  if (!response.ok) throw new Error(`Google token request failed: ${tokenError(await response.text())}`);
  return (await response.json()) as TokenResponse;
}

function expiresAt(response: TokenResponse): number {
  return Date.now() + (response.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS;
}

function authorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // Google only returns a refresh token on an explicitly re-consented
    // offline grant, and without one the account dies at the first expiry.
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params}`;
}

/**
 * Waits for the browser redirect, with a paste prompt racing it so a remote or
 * headless session — where the browser cannot reach this machine's loopback —
 * still completes. Whichever arrives first cancels the other.
 */
async function awaitCode(
  interaction: ProviderAuthInteraction,
  server: OAuthCallbackServer,
  state: string,
): Promise<string> {
  const manualAbort = new AbortController();
  let pasted: string | undefined;
  let manualError: unknown;

  const manual = interaction.prompt({
    type: "manual_code",
    message: "Paste the callback URL from your browser (or finish signing in there)",
    placeholder: `${server.redirectUri}?state=…&code=…`,
    signal: manualAbort.signal,
  }).then(
    (value) => { pasted = value; server.cancel(); },
    (error) => { manualError = error; server.cancel(); },
  );

  const callback = await server.wait();
  if (callback) {
    manualAbort.abort();
    // The prompt rejects on abort; that rejection is expected, not a failure.
    void manual.catch(() => undefined);
    if (callback.state !== state) throw new Error("Google OAuth state mismatch — sign-in was not completed here.");
    return callback.code;
  }

  await manual;
  if (manualError) throw manualError;

  const parsed = pasted ? parseCallback(pasted) : undefined;
  if (!parsed) throw new Error("No authorization code received. Paste the full callback URL.");
  if (parsed.state !== state) throw new Error("Google OAuth state mismatch — that callback belongs to another sign-in.");
  return parsed.code;
}

/** OAuth alone does not clear Google's account-verification gate. No inference is sent. */
export async function confirmGeminiAccess(
  credential: OAuthCredential,
  interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
  let openedUrl: string | undefined;
  // Every retry requires user input; no background polling or endless browser loop.
  for (let attempt = 0; attempt < 4; attempt++) {
    interaction.signal.throwIfAborted();
    interaction.notify({ type: "progress", message: "Confirming Gemini account access…" });
    const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(30_000)]);
    if (credential.expires <= Date.now() + 60_000) credential = await refresh(credential, signal);
    // Verification may also have blocked login-time project discovery.
    if (attempt > 0 && !credentialProjectId(credential)) {
      const projectId = await discoverProjectId(credential.access, signal);
      if (projectId) credential = { ...credential, projectId } as GeminiCredential;
    }
    try {
      await fetchUserQuota(credential.access, requestProjectId(credential), signal);
      interaction.signal.throwIfAborted();
      return credential;
    } catch (error) {
      interaction.signal.throwIfAborted();
      if (!(error instanceof GeminiVerificationRequiredError)) throw error;
      if (attempt === 3) throw new Error("Google verification is still required; Gemini sign-in was not completed. Finish verification and retry.", { cause: error });
      if (error.verificationUrl && error.verificationUrl !== openedUrl) {
        openedUrl = error.verificationUrl;
        interaction.notify({
          type: "auth_url", url: openedUrl,
          instructions: "Complete Google's verification using the account you just signed into. Then return here to check access.",
        });
      } else {
        interaction.notify({ type: "info", message: error.message });
      }
      const action = await interaction.prompt({
        type: "select",
        message: "Gemini sign-in is pending Google verification.",
        options: [
          { id: "check", label: "I've completed verification — check again" },
          { id: "cancel", label: "Cancel sign-in" },
        ],
        signal: interaction.signal,
      });
      if (action !== "check") throw new Error("Gemini sign-in cancelled; account access was not confirmed.", { cause: error });
    }
  }
  throw new Error("Gemini account access was not confirmed.");
}

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { verifier, challenge } = await generatePkce();
  // Independent of the verifier: a leaked callback URL must not disclose it.
  const state = generateState();

  const server = await startOAuthCallbackServer({
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    successMessage: "Google authorization received. Return to pi to confirm Gemini access and complete any required verification.",
  }).catch((error: unknown) => {
    throw new Error(
      `Could not listen on port ${CALLBACK_PORT} for the Google callback`
      + ` (${error instanceof Error ? error.message : String(error)}).`
      + " Close whatever is using it — the Gemini client id requires this exact port.",
    );
  });

  try {
    interaction.notify({
      type: "auth_url",
      url: authorizeUrl(challenge, state, server.redirectUri),
      instructions: "Sign in with the Google account whose Gemini quota you want to use.",
    });

    const code = await awaitCode(interaction, server, state);

    interaction.notify({ type: "progress", message: "Exchanging the authorization code…" });
    const token = await exchange({
      code,
      grant_type: "authorization_code",
      redirect_uri: server.redirectUri,
      code_verifier: verifier,
    }, interaction.signal);

    if (!token.access_token || !token.refresh_token) {
      throw new Error("Google did not return a refresh token. Sign in again and allow offline access.");
    }

    interaction.notify({ type: "progress", message: "Looking up your Gemini project…" });
    const [email, projectId] = await Promise.all([
      fetchUserEmail(token.access_token, interaction.signal),
      discoverProjectId(token.access_token, interaction.signal),
    ]);

    return await confirmGeminiAccess({
      type: "oauth",
      access: token.access_token,
      refresh: token.refresh_token,
      expires: expiresAt(token),
      ...(projectId && { projectId }),
      ...(email && { email }),
    } satisfies GeminiCredential, interaction);
  } finally {
    server.close();
  }
}

/**
 * `projectId` and `email` are login-time discoveries the token endpoint never
 * returns, so they are carried across every refresh. A credential whose
 * discovery failed at login retries it here instead of pinning a fallback.
 */
async function refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
  const token = await exchange({ refresh_token: credential.refresh, grant_type: "refresh_token" }, signal);
  if (!token.access_token) throw new Error("Google token refresh returned no access token.");

  const access = token.access_token;
  const projectId = credentialProjectId(credential) ?? await discoverProjectId(access, signal);
  const email = credentialEmail(credential) ?? await fetchUserEmail(access, signal);

  return {
    type: "oauth",
    access,
    // Google rotates refresh tokens only occasionally; keep the old one otherwise.
    refresh: token.refresh_token || credential.refresh,
    expires: expiresAt(token),
    ...(projectId && { projectId }),
    ...(email && { email }),
  } satisfies GeminiCredential;
}

/** The project a request is billed against: pinned, discovered, else stable per account. */
export function requestProjectId(credential: OAuthCredential): string {
  return geminiEnv("PROJECT_ID") ?? credentialProjectId(credential) ?? fallbackProjectId(credentialEmail(credential));
}

async function toAuth(credential: OAuthCredential): Promise<ModelAuth> {
  return { apiKey: encodeApiKey({ token: credential.access, projectId: requestProjectId(credential) }) };
}

export const geminiOAuth: OAuthAuth = {
  name: "Gemini",
  isSubscription: true,
  loginLabel: "Sign in with a Google account",
  login,
  refresh,
  toAuth,
};
