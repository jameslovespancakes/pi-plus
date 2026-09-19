import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "../env.ts";

/**
 * Complete Artificial Analysis model dataset, cached on disk.
 *
 * Every field the API returns is stored verbatim: all 17 benchmark
 * evaluations, all pricing fields, and all latency/throughput measurements.
 * Derived cost-efficiency ratios are computed on top. All network access
 * degrades to the cache so routing never blocks on the network.
 *
 * Refresh semantics deliberately mirror pi's own remote model catalog
 * (`dist/core/remote-catalog-provider.js`): restore from disk first, only go to
 * the network when the entry is older than the refresh interval, and revalidate
 * with `If-None-Match` so an unchanged dataset costs one 304 instead of a
 * multi-megabyte download.
 */

const AA_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
/** Matches pi's REMOTE_CATALOG_REFRESH_INTERVAL_MS. */
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;

export type Confidence = "measured" | "inferred" | "unrated";

/** Every evaluation key Artificial Analysis publishes, with display metadata. */
export const EVALUATIONS = [
  { key: "artificial_analysis_intelligence_index", label: "Intelligence Index", scale: "index", group: "composite" },
  { key: "artificial_analysis_coding_index", label: "Coding Index", scale: "index", group: "composite" },
  { key: "artificial_analysis_math_index", label: "Math Index", scale: "index", group: "composite" },
  { key: "terminalbench_hard", label: "Terminal-Bench Hard", scale: "fraction", group: "agentic" },
  { key: "terminalbench_v2_1", label: "Terminal-Bench 2.1", scale: "fraction", group: "agentic" },
  { key: "tau2", label: "τ²-bench (agentic tools)", scale: "fraction", group: "agentic" },
  { key: "tau_banking", label: "τ-bench Banking", scale: "fraction", group: "agentic" },
  { key: "livecodebench", label: "LiveCodeBench", scale: "fraction", group: "coding" },
  { key: "scicode", label: "SciCode", scale: "fraction", group: "coding" },
  { key: "lcr", label: "Long Context Reasoning", scale: "fraction", group: "reasoning" },
  { key: "gpqa", label: "GPQA Diamond", scale: "fraction", group: "reasoning" },
  { key: "hle", label: "Humanity's Last Exam", scale: "fraction", group: "reasoning" },
  { key: "mmlu_pro", label: "MMLU-Pro", scale: "fraction", group: "reasoning" },
  { key: "ifbench", label: "IFBench (instruction following)", scale: "fraction", group: "reasoning" },
  { key: "aime_25", label: "AIME 2025", scale: "fraction", group: "math" },
  { key: "aime", label: "AIME", scale: "fraction", group: "math" },
  { key: "math_500", label: "MATH-500", scale: "fraction", group: "math" },
] as const;

export type EvaluationKey = (typeof EVALUATIONS)[number]["key"];

export interface QualityRecord {
  slug: string;
  name: string;
  creator: string;
  releaseDate?: string;
  evaluations: Partial<Record<EvaluationKey, number>>;
  pricing: {
    inputPer1M?: number;
    outputPer1M?: number;
    blended3to1Per1M?: number;
  };
  performance: {
    outputTokensPerSecond?: number;
    timeToFirstTokenSeconds?: number;
    timeToFirstAnswerTokenSeconds?: number;
  };
}

/**
 * Same shape as pi's ModelsStoreEntry, so the two caches can be reasoned about
 * (and debugged) identically.
 */
interface QualityStore {
  records: Record<string, QualityRecord>;
  /** Unix timestamp of the last completed remote check. */
  checkedAt?: number;
  /** Unix timestamp from the remote dataset's Last-Modified header. */
  lastModified?: number;
  /** Opaque ETag validator, stored verbatim and echoed back as If-None-Match. */
  etag?: string;
  source: string;
}

let cache: QualityStore | undefined;
let inFlight: Promise<string[]> | undefined;

function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function cachePath(): string {
  return join(agentDir(), "model-quality.json");
}

function readKey(): string | undefined {
  return env("ARTIFICIAL_ANALYSIS_API_KEY");
}

/** `openrouter/z-ai/glm-5.3` -> `glm-5-3`, `openai-codex/gpt-5.6-luna` -> `gpt-5-6-luna`. */
export function normalizeSlug(modelId: string): string {
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  return bare.toLowerCase().replace(/[._]/g, "-").replace(/-latest$/, "").replace(/-\d{8}$/, "");
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Fractions (0-1) are reported as percentages so every metric shares one scale. */
export function normalizedScore(key: EvaluationKey, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const definition = EVALUATIONS.find((entry) => entry.key === key);
  return definition?.scale === "fraction" ? value * 100 : value;
}

function loadCache(): void {
  if (cache) return;
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as QualityStore & { fetchedAt?: number };
    if (!parsed?.records) return;
    // Migrate the pre-store format, which only had `fetchedAt`.
    cache = {
      records: parsed.records,
      checkedAt: parsed.checkedAt ?? parsed.fetchedAt,
      lastModified: parsed.lastModified,
      etag: parsed.etag,
      source: parsed.source ?? "artificial-analysis",
    };
  } catch { /* first run */ }
}

function persist(next: QualityStore): void {
  cache = next;
  try {
    writeFileSync(cachePath(), JSON.stringify(next), "utf8");
  } catch { /* cache write is best effort */ }
}

export function qualityAgeMs(): number | undefined {
  loadCache();
  return cache?.checkedAt !== undefined ? Date.now() - cache.checkedAt : undefined;
}

/** Cache metadata, for display by /model-info refresh. */
export function qualityStatus(): { checkedAt?: number; lastModified?: number; records: number; hasEtag: boolean } {
  loadCache();
  return {
    checkedAt: cache?.checkedAt,
    lastModified: cache?.lastModified,
    records: Object.keys(cache?.records ?? {}).length,
    hasEtag: !!cache?.etag,
  };
}

export function qualityRecordCount(): number {
  loadCache();
  return Object.keys(cache?.records ?? {}).length;
}

export async function refreshQuality(force = false): Promise<string[]> {
  loadCache();

  // Restored from disk and still inside the window: nothing to do.
  const age = qualityAgeMs();
  if (!force && age !== undefined && age < REFRESH_INTERVAL_MS) return [];
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const warnings: string[] = [];
    const key = readKey();
    if (!key) return ["artificial-analysis: no API key, run /model-info setup"];

    const stored = cache;
    // Only revalidate when a cached body backs the validator, so a 304 can never
    // leave the dataset empty.
    const validator = stored && Object.keys(stored.records).length > 0 ? stored.etag : undefined;

    try {
      const response = await fetch(AA_URL, {
        headers: {
          "x-api-key": key,
          ...(validator ? { "if-none-match": validator } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const checkedAt = Date.now();

      if (response.status === 304 && stored) {
        // Unchanged upstream: keep the dataset and the validator, stamp the check.
        persist({ ...stored, checkedAt });
        return [];
      }

      if (!response.ok) {
        // Drop the etag so the next attempt re-downloads rather than revalidating
        // against a validator we can no longer trust.
        if (stored) persist({ ...stored, checkedAt, etag: undefined });
        return [`artificial-analysis: HTTP ${response.status}`];
      }

      const body = await response.json() as { data?: any[] };
      const records: Record<string, QualityRecord> = {};

      for (const model of body.data ?? []) {
        const slug = String(model.slug ?? "").toLowerCase();
        if (!slug) continue;
        const source = model.evaluations ?? {};
        const evaluations: Partial<Record<EvaluationKey, number>> = {};
        for (const { key: evaluationKey } of EVALUATIONS) {
          const value = num(source[evaluationKey]);
          if (value !== undefined) evaluations[evaluationKey] = value;
        }
        const pricing = model.pricing ?? {};
        records[slug] = {
          slug,
          name: String(model.name ?? slug),
          creator: String(model.model_creator?.name ?? "unknown"),
          releaseDate: typeof model.release_date === "string" ? model.release_date : undefined,
          evaluations,
          pricing: {
            inputPer1M: num(pricing.price_1m_input_tokens),
            outputPer1M: num(pricing.price_1m_output_tokens),
            blended3to1Per1M: num(pricing.price_1m_blended_3_to_1),
          },
          performance: {
            outputTokensPerSecond: num(model.median_output_tokens_per_second),
            timeToFirstTokenSeconds: num(model.median_time_to_first_token_seconds),
            timeToFirstAnswerTokenSeconds: num(model.median_time_to_first_answer_token),
          },
        };
      }

      if (Object.keys(records).length === 0) {
        if (stored) persist({ ...stored, checkedAt, etag: undefined });
        return ["artificial-analysis: empty dataset"];
      }

      const lastModifiedHeader = response.headers.get("last-modified");
      const lastModified = lastModifiedHeader ? Date.parse(lastModifiedHeader) : undefined;
      persist({
        records,
        checkedAt,
        lastModified: Number.isNaN(lastModified) ? undefined : lastModified,
        etag: response.headers.get("etag") ?? undefined,
        source: "artificial-analysis",
      });
    } catch (error) {
      // Network failure keeps the old dataset usable but forces a full re-fetch
      // next time rather than trusting a stale validator.
      if (cache) persist({ ...cache, checkedAt: Date.now(), etag: undefined });
      warnings.push(`artificial-analysis: ${error instanceof Error ? error.message : String(error)}`);
    }
    return warnings;
  })().finally(() => { inFlight = undefined; });

  return inFlight;
}

export interface CostEfficiency {
  /** Intelligence index per dollar of blended 3:1 spend. */
  intelligencePerDollar?: number;
  codingPerDollar?: number;
  agenticPerDollar?: number;
}

export function costEfficiency(record: QualityRecord | undefined): CostEfficiency {
  if (!record) return {};
  const price = record.pricing.blended3to1Per1M;
  if (price === undefined || price <= 0) return {};
  const ratio = (value: number | undefined) => (value === undefined ? undefined : Number((value / price).toFixed(2)));
  return {
    intelligencePerDollar: ratio(record.evaluations.artificial_analysis_intelligence_index),
    codingPerDollar: ratio(record.evaluations.artificial_analysis_coding_index),
    agenticPerDollar: ratio(normalizedScore("terminalbench_hard", record.evaluations.terminalbench_hard)),
  };
}

export interface QualityLookup {
  record?: QualityRecord;
  efficiency: CostEfficiency;
  confidence: Confidence;
  basis: string;
}

/**
 * Resolve a pi model id, preferring the entry matching the requested thinking
 * level, then the base model, then the closest same-family sibling.
 */
export function qualityFor(modelId: string, thinkingLevel?: string): QualityLookup {
  loadCache();
  const records = cache?.records ?? {};
  const base = normalizeSlug(modelId);

  const levelled = thinkingLevel && thinkingLevel !== "off" ? records[`${base}-${thinkingLevel}`] : undefined;
  if (levelled) return { record: levelled, efficiency: costEfficiency(levelled), confidence: "measured", basis: levelled.slug };

  const exact = records[base];
  if (exact) return { record: exact, efficiency: costEfficiency(exact), confidence: "measured", basis: exact.slug };

  let best: QualityRecord | undefined;
  for (const record of Object.values(records)) {
    if (!base.includes(record.slug) && !record.slug.includes(base)) continue;
    if (!best || record.slug.length > best.slug.length) best = record;
  }
  if (best) return { record: best, efficiency: costEfficiency(best), confidence: "inferred", basis: `nearest match ${best.slug}` };

  return { efficiency: {}, confidence: "unrated", basis: "no Artificial Analysis entry" };
}

export function allRecords(): QualityRecord[] {
  loadCache();
  return Object.values(cache?.records ?? {});
}
