import { agentPath, readJson, writeJson } from "../store.ts";

/**
 * Live Anthropic model list.
 *
 * pi's bundled catalogue is generated at build time, so a model Anthropic
 * ships afterwards is invisible to pi until pi is upgraded — `claude-opus-5-5`
 * was usable for days while the picker denied it existed. Claude Code does not
 * have that problem because it asks the API.
 *
 * `GET /v1/models` returns identity only (`id`, `display_name`), never limits
 * or pricing, so a discovered model still needs those filled in. They are
 * inherited from the newest model of the same family in pi's catalogue rather
 * than invented here — see `models.ts`.
 *
 * The result is cached on disk so the picker is correct on the very first
 * render, before any network call has finished.
 */

const CACHE_FILE = "anthropic-models.json";
/** Re-ask once a day; a new model is news, not an emergency. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface LiveModel {
  id: string;
  displayName?: string;
}

interface CacheFile {
  version: 1;
  fetchedAt: number;
  models: LiveModel[];
}

const EMPTY: CacheFile = { version: 1, fetchedAt: 0, models: [] };

export function catalogPath(): string {
  return process.env.PI_PLUS_ANTHROPIC_MODELS_FILE ?? agentPath(CACHE_FILE);
}

function load(): CacheFile {
  const raw = readJson<Partial<CacheFile>>(catalogPath(), { ...EMPTY });
  return {
    version: 1,
    fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : 0,
    models: Array.isArray(raw.models)
      ? raw.models.filter((model): model is LiveModel => typeof model?.id === "string" && model.id.length > 0)
      : [],
  };
}

/** Last known live list. Empty before the first successful fetch. */
export function cachedAnthropicModels(): LiveModel[] {
  return load().models;
}

export function catalogIsStale(now = Date.now()): boolean {
  return now - load().fetchedAt > CATALOG_TTL_MS;
}

/** Test seam and reset path. */
export function writeAnthropicCatalog(models: LiveModel[], fetchedAt = Date.now()): void {
  writeJson(catalogPath(), { version: 1, fetchedAt, models } satisfies CacheFile, true);
}

interface ModelsResponse {
  data?: { id?: string; display_name?: string }[];
}

/**
 * Asks Anthropic what this credential can actually use.
 *
 * `auth` comes from pi's resolved provider auth, so an OAuth subscription and
 * a plain API key both work and the token is already refreshed.
 */
export interface ResolvedAnthropicAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
  /** pi reports "OAuth" for a subscription credential. */
  source?: string;
}

/**
 * Only a real API key goes in `x-api-key`; everything else is a bearer token.
 *
 * A prefix test alone is a trap: an Anthropic *OAuth* token is `sk-ant-oat…`
 * and an API key is `sk-ant-api…`, so checking for `sk-` routes subscription
 * tokens into the wrong header and the endpoint answers 401.
 */
function usesApiKeyHeader(auth: ResolvedAnthropicAuth): boolean {
  if (auth.source === "OAuth") return false;
  return (auth.apiKey ?? "").startsWith("sk-ant-api");
}

export async function fetchAnthropicModels(
  auth: ResolvedAnthropicAuth,
  signal?: AbortSignal,
): Promise<LiveModel[]> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) headers[key] = value;
  }

  if (auth.apiKey) {
    if (usesApiKeyHeader(auth)) headers["x-api-key"] = auth.apiKey;
    else headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  // Exactly this one beta. The model list rejects the request when the
  // Claude Code betas meant for /v1/messages are carried over.
  headers["anthropic-beta"] = "oauth-2025-04-20";

  const base = (auth.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/models?limit=200`, { headers, signal });
  if (!response.ok) {
    throw new Error(`Anthropic model list failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as ModelsResponse;
  return (body.data ?? [])
    .filter((model) => typeof model?.id === "string" && model.id.length > 0)
    .map((model) => ({ id: model.id!, ...(model.display_name && { displayName: model.display_name }) }));
}

/**
 * Refreshes the cache. Returns the ids that were not already known, so a
 * caller can decide whether re-registering the provider is worth it.
 */
export async function refreshAnthropicCatalog(
  auth: ResolvedAnthropicAuth,
  signal?: AbortSignal,
): Promise<string[]> {
  const before = new Set(cachedAnthropicModels().map((model) => model.id));
  const models = await fetchAnthropicModels(auth, signal);
  if (models.length === 0) return [];

  writeAnthropicCatalog(models);
  return models.map((model) => model.id).filter((id) => !before.has(id));
}
