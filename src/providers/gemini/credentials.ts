import type { OAuthCredential } from "@earendil-works/pi-ai";

/**
 * A Gemini request needs two things per account: the OAuth access token
 * and the Cloud Code project the account is served under. pi's OAuth path
 * hands the stream only a `ModelAuth` (`apiKey`/`headers`/`baseUrl`), so the
 * project has to travel inside one of those.
 *
 * It rides in `apiKey` rather than a header because a header would be sent to
 * Google verbatim. The encoding is private to this provider: `toAuth()`
 * produces it, the stream consumes it, and the account pool reads the token
 * back out to attribute quota. All three share this one definition.
 */

export interface GeminiCredential extends OAuthCredential {
  /** Project discovered at login; absent when Google allocated none. */
  projectId?: string;
  email?: string;
}

export interface GeminiApiKey {
  token: string;
  projectId: string;
}

export function encodeApiKey(key: GeminiApiKey): string {
  return JSON.stringify({ token: key.token, projectId: key.projectId });
}

/** Throws with a recoverable instruction rather than letting Google answer 401. */
export function decodeApiKey(apiKey: string | undefined): GeminiApiKey {
  if (!apiKey) throw new Error("Gemini requires OAuth. Run /login gemini.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(apiKey);
  } catch {
    throw new Error("Gemini credentials are unreadable. Run /login gemini to re-authenticate.");
  }

  const { token, projectId } = (parsed ?? {}) as Partial<GeminiApiKey>;
  if (typeof token !== "string" || !token || typeof projectId !== "string" || !projectId) {
    throw new Error("Gemini credentials are missing a token or project. Run /login gemini.");
  }
  return { token, projectId };
}

export function credentialProjectId(credential: OAuthCredential): string | undefined {
  const value = (credential as GeminiCredential).projectId;
  return typeof value === "string" && value ? value : undefined;
}

export function credentialEmail(credential: OAuthCredential): string | undefined {
  const value = (credential as GeminiCredential).email;
  return typeof value === "string" && value ? value : undefined;
}
