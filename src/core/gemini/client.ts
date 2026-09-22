import { createHash } from "node:crypto";

/**
 * Gemini's `v1internal` control plane: project discovery, the account
 * email, and the live model list.
 *
 * Plain `fetch`, no pi types, so everything here is unit-testable without a
 * session. The wire details (endpoints, User-Agent, request bodies) follow
 * the Antigravity CLI as tracked by `pi-antigravity`; the backend identifies
 * its callers and refuses ones it does not recognise.
 */

/** Daily carries rollouts first, so it leads; production is the last resort. */
export const GEMINI_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const GEMINI_ENDPOINTS: readonly string[] = [
  GEMINI_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

export const GEMINI_USER_AGENT =
  "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";

/** Metadata lookups must be quick; a stalled endpoint falls through to the next. */
const DISCOVERY_TIMEOUT_MS = 8_000;

export function geminiEnv(name: string): string | undefined {
  const value = process.env[`PI_GEMINI_${name}`]?.trim();
  return value || undefined;
}

export function geminiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_USER_AGENT,
  };
}

/**
 * Endpoints for a request, in order. A base URL the user configured for the
 * provider (pi's `models.json` override) is used alone; otherwise every
 * Gemini endpoint is tried.
 */
export function endpointsFor(baseUrl?: string): readonly string[] {
  const configured = baseUrl?.trim().replace(/\/+$/, "");
  return configured && configured !== GEMINI_ENDPOINT ? [configured] : GEMINI_ENDPOINTS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** POSTs to one endpoint; undefined for any non-2xx or transport failure. */
async function postJson(endpoint: string, path: string, token: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(`${endpoint}/v1internal:${path}`, {
      method: "POST",
      headers: geminiHeaders(token),
      body: JSON.stringify(body),
      signal: timeoutSignal(signal),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch (error) {
    // A caller abort is a decision, not an endpoint failure to route around.
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/** UUID-shaped id derived from a seed, so the same account always maps to the same value. */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Project for an account Google allocated none to. Consumer Gemini
 * accounts are served without one, so a stable per-account value is enough;
 * `PI_GEMINI_PROJECT_ID` pins a real one.
 */
export function fallbackProjectId(email?: string): string {
  return geminiEnv("PROJECT_ID") ?? stableUuid(`antigravity:${email || "antigravity-default"}`);
}

/** The project field has moved between response shapes; accept each of them. */
export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct = data.geminiProjectId
    ?? data.projectId
    ?? data.backendProjectId
    ?? data.userDefinedCloudaicompanionProject
    ?? data.cloudaicompanionProject
    ?? data.project;
  if (typeof direct === "string" && direct) return direct;
  if (isRecord(direct) && typeof direct.id === "string" && direct.id) return direct.id;

  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string" && item) return item;
      const nested = extractProjectId(item);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * The account's project, or undefined when Google allocated none — callers
 * then fall back to {@link fallbackProjectId}. `PI_GEMINI_PROJECT_ID` wins.
 */
export async function discoverProjectId(token: string, signal?: AbortSignal): Promise<string | undefined> {
  const pinned = geminiEnv("PROJECT_ID");
  if (pinned) return pinned;

  for (const endpoint of GEMINI_ENDPOINTS) {
    const status = await postJson(endpoint, "loadCodeAssist", token, { metadata: { ideType: "ANTIGRAVITY" } }, signal);
    if (status === undefined) continue;
    const project = extractProjectId(status);
    if (project) return project;
    // The account answered but carries no project: ask for its list instead.
    for (const listing of GEMINI_ENDPOINTS) {
      const projects = await postJson(listing, "listCloudAICompanionProjects", token, {}, signal);
      if (projects !== undefined) return extractProjectId(projects);
    }
    return undefined;
  }
  return undefined;
}

/** Account label for the picker. Best effort: an account without it still works. */
export async function fetchUserEmail(token: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutSignal(signal),
    });
    if (!response.ok) return undefined;
    const email = ((await response.json()) as { email?: unknown }).email;
    return typeof email === "string" && email ? email : undefined;
  } catch {
    return undefined;
  }
}

/** One entry of `fetchAvailableModels`, keyed by its runtime model id. */
export interface RuntimeModelInfo {
  isInternal?: boolean;
  displayName?: string;
  label?: string;
  modelName?: string;
  supportsThinking?: boolean;
  supportsImages?: boolean;
}

/**
 * The models this account can use, merged across every endpoint so rollouts
 * that exist only on daily or sandbox still appear. Throws only when no
 * endpoint answered at all.
 */
export async function fetchAvailableModels(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<Record<string, RuntimeModelInfo>> {
  const answers = await Promise.all(GEMINI_ENDPOINTS.map((endpoint) =>
    postJson(endpoint, "fetchAvailableModels", token, { project: projectId }, signal)));

  const catalogues = answers.filter(isRecord);
  if (catalogues.length === 0) throw new Error("Gemini did not return a model list from any endpoint.");

  const merged: Record<string, RuntimeModelInfo> = {};
  for (const catalogue of catalogues) {
    if (isRecord(catalogue.models)) Object.assign(merged, catalogue.models);
  }
  return merged;
}
