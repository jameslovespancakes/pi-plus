import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  EVALUATIONS,
  type EvaluationKey,
  costEfficiency,
  normalizedScore,
  qualityAgeMs,
  qualityFor,
  qualityRecordCount,
  qualityStatus,
  refreshQuality,
} from "../../core/catalog/quality.ts";
import { ensureFresh, usageState } from "../../services/usage-service.ts";
import { geminiQuotaFamily } from "../../core/gemini/quota.ts";
import { combinedWindow, isGeminiAccount, pooledWindow } from "../../core/quota/pool.ts";
import { env, isFromProcessEnv, maskSecret, setEnv } from "../../core/env.ts";
import { fitId } from "../../ui/format.ts";

/**
 * Exposes the Artificial Analysis benchmark catalogue to the model so it can
 * pick a model per task instead of relying on fixed small/medium/big profiles.
 */

const SUBSCRIPTION_PROVIDERS = new Set(["anthropic", "openai-codex", "gemini", "kimi-coding"]);

type SortKey = "coding" | "intelligence" | "agentic" | "reasoning" | "cost" | "speed" | "cost_efficiency";

const SORT_ACCESSORS: Record<SortKey, (entry: Entry) => number> = {
  coding: (entry) => entry.scores.artificial_analysis_coding_index ?? -1,
  intelligence: (entry) => entry.scores.artificial_analysis_intelligence_index ?? -1,
  agentic: (entry) => entry.scores.terminalbench_hard ?? entry.scores.terminalbench_v2_1 ?? entry.scores.tau2 ?? -1,
  reasoning: (entry) => entry.scores.gpqa ?? entry.scores.hle ?? -1,
  cost: (entry) => -(entry.pricing.blended3to1Per1M ?? Number.MAX_SAFE_INTEGER),
  speed: (entry) => entry.performance.outputTokensPerSecond ?? -1,
  cost_efficiency: (entry) => entry.efficiency.codingPerDollar ?? entry.efficiency.intelligencePerDollar ?? -1,
};

interface Entry {
  id: string;
  provider: string;
  billing: "subscription" | "metered";
  quotaLeftPercent?: number;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  confidence: string;
  basis: string;
  benchmarkName?: string;
  releaseDate?: string;
  scores: Partial<Record<EvaluationKey, number>>;
  pricing: { inputPer1M?: number; outputPer1M?: number; blended3to1Per1M?: number };
  performance: { outputTokensPerSecond?: number; timeToFirstTokenSeconds?: number };
  efficiency: { intelligencePerDollar?: number; codingPerDollar?: number; agenticPerDollar?: number };
}

function quotaFor(provider: string, modelId: string): number | undefined {
  const state = usageState();
  const rows = state.rows;
  if (provider === "anthropic") {
    // The pool's figure, not whichever account happens to be listed first.
    const pool = combinedWindow(rows, "5h", state.accounts, Date.now(), true);
    return pool ? Math.round(pool.remaining) : undefined;
  }
  if (provider === "gemini") {
    // Gemini pools per model family, so the figure depends on the model.
    const family = geminiQuotaFamily(modelId);
    const expected = state.geminiAccounts || new Set(rows.filter(isGeminiAccount).map((row) => row.group)).size;
    const pool = family ? pooledWindow(rows, family, expected, isGeminiAccount, Date.now(), true) : undefined;
    return pool ? Math.round(pool.remaining) : undefined;
  }
  const match = provider === "openai-codex"
    ? rows.find((row) => row.group === "Codex" && row.label === "weekly")
    : undefined;
  return match ? Math.round(match.remaining) : undefined;
}

function buildEntry(model: any): Entry {
  const lookup = qualityFor(`${model.provider}/${model.id}`);
  const record = lookup.record;
  const scores: Partial<Record<EvaluationKey, number>> = {};
  for (const { key } of EVALUATIONS) {
    const value = normalizedScore(key, record?.evaluations[key]);
    if (value !== undefined) scores[key] = Number(value.toFixed(1));
  }
  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    billing: SUBSCRIPTION_PROVIDERS.has(model.provider) ? "subscription" : "metered",
    quotaLeftPercent: quotaFor(model.provider, model.id),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: !!model.reasoning,
    confidence: lookup.confidence,
    basis: lookup.basis,
    benchmarkName: record?.name,
    releaseDate: record?.releaseDate,
    scores,
    pricing: record?.pricing ?? {},
    performance: {
      outputTokensPerSecond: record?.performance.outputTokensPerSecond,
      timeToFirstTokenSeconds: record?.performance.timeToFirstTokenSeconds,
    },
    efficiency: costEfficiency(record),
  };
}

/**
 * OpenRouter republishes the same underlying model many times (`:batch`,
 * `:free`, `-pro`, `~` prefixes). Collapse them to the best single row unless
 * the caller explicitly asked for variants.
 */
function dedupe(entries: Entry[]): Entry[] {
  const best = new Map<string, Entry>();
  for (const entry of entries) {
    // Unrated models share one basis string, so they must key on their own id
    // or they would collapse into a single row and disappear from the catalogue.
    const family = entry.confidence === "unrated"
      ? `unrated:${entry.id}`
      : entry.basis.replace(/^nearest match /, "");
    const current = best.get(family);
    if (!current) {
      best.set(family, entry);
      continue;
    }
    const better = entry.billing === "subscription" && current.billing !== "subscription"
      || (entry.billing === current.billing && entry.confidence === "measured" && current.confidence !== "measured")
      || (entry.billing === current.billing && entry.confidence === current.confidence && entry.id.length < current.id.length);
    if (better) best.set(family, entry);
  }
  return [...best.values()];
}

function formatTable(entries: Entry[]): string {
  const cell = (value: number | undefined, width = 6) =>
    (value === undefined ? "-".padStart(width) : value.toFixed(1).padStart(width));
  const header = [
    "model".padEnd(40),
    "bill".padEnd(4),
    "quota".padStart(5),
    "intel".padStart(6),
    "code".padStart(6),
    "tbHard".padStart(6),
    "tb2.1".padStart(6),
    "tau2".padStart(6),
    "$/1M".padStart(7),
    "tok/s".padStart(6),
    "code/$".padStart(7),
    "conf",
  ].join(" ");

  const lines = entries.map((entry) => [
    fitId(entry.id, 40),
    (entry.billing === "subscription" ? "sub" : "paid").padEnd(4),
    (entry.quotaLeftPercent === undefined ? "-" : `${entry.quotaLeftPercent}%`).padStart(5),
    cell(entry.scores.artificial_analysis_intelligence_index),
    cell(entry.scores.artificial_analysis_coding_index),
    cell(entry.scores.terminalbench_hard),
    cell(entry.scores.terminalbench_v2_1),
    cell(entry.scores.tau2),
    cell(entry.pricing.blended3to1Per1M, 7),
    cell(entry.performance.outputTokensPerSecond),
    cell(entry.efficiency.codingPerDollar, 7),
    entry.confidence,
  ].join(" "));

  return [header, "-".repeat(header.length), ...lines].join("\n");
}

function formatFull(entry: Entry): string {
  const lines = [
    `${entry.id}${entry.benchmarkName ? `  ${entry.benchmarkName}` : ""}`,
    `  billing: ${entry.billing}${entry.quotaLeftPercent !== undefined ? ` · quota left ${entry.quotaLeftPercent}%` : ""}`,
    `  context: ${entry.contextWindow.toLocaleString()} · max out: ${entry.maxTokens.toLocaleString()} · reasoning: ${entry.reasoning}`,
    `  released: ${entry.releaseDate ?? "unknown"} · benchmark confidence: ${entry.confidence} (${entry.basis})`,
    "  benchmarks:",
  ];

  let group = "";
  for (const definition of EVALUATIONS) {
    const value = entry.scores[definition.key];
    if (value === undefined) continue;
    if (definition.group !== group) {
      group = definition.group;
      lines.push(`    [${group}]`);
    }
    lines.push(`      ${definition.label.padEnd(34)} ${value.toFixed(1).padStart(6)}`);
  }

  lines.push(
    "  pricing per 1M tokens:",
    `      input ${entry.pricing.inputPer1M ?? "-"} · output ${entry.pricing.outputPer1M ?? "-"} · blended 3:1 ${entry.pricing.blended3to1Per1M ?? "-"}`,
    "  performance:",
    `      ${entry.performance.outputTokensPerSecond?.toFixed(1) ?? "-"} tok/s · first token ${entry.performance.timeToFirstTokenSeconds?.toFixed(1) ?? "-"}s`,
    "  cost efficiency (score per $ blended):",
    `      intelligence ${entry.efficiency.intelligencePerDollar ?? "-"} · coding ${entry.efficiency.codingPerDollar ?? "-"} · agentic ${entry.efficiency.agenticPerDollar ?? "-"}`,
  );
  return lines.join("\n");
}

export function registerCatalogTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description:
      "List models available to this pi session with full Artificial Analysis benchmark data: intelligence/coding/math indices, "
      + "Terminal-Bench, τ²-bench, LiveCodeBench, SciCode, GPQA, HLE, MMLU-Pro, IFBench, AIME, MATH-500, long-context reasoning, "
      + "pricing, throughput, latency, and cost-efficiency ratios. Also reports subscription vs metered billing and remaining "
      + "subscription quota. Use it to choose the model for a task instead of guessing.",
    promptSnippet: "Inspect available models with benchmark scores, price, speed and remaining quota",
    promptGuidelines: [
      "Call list_models before choosing a model for a delegated task or workflow stage, and prefer subscription models with quota remaining.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring filter on model id" })),
      provider: Type.Optional(Type.String({ description: "Filter by provider, e.g. anthropic or openai-codex" })),
      sort_by: Type.Optional(StringEnum(["coding", "intelligence", "agentic", "reasoning", "cost", "speed", "cost_efficiency"] as const)),
      detail: Type.Optional(StringEnum(["table", "full"] as const)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      include_variants: Type.Optional(Type.Boolean({ description: "Include duplicate OpenRouter re-publications such as :batch and -pro" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const warnings = await refreshQuality(false);
      // Guarantees quota figures even in headless sessions, where nothing else
      // would have triggered a usage poll.
      await ensureFresh(ctx);
      const available = await ctx.modelRegistry.getAvailable();

      let entries = available.map(buildEntry);
      if (params.provider) entries = entries.filter((entry) => entry.provider === params.provider);
      if (params.query) {
        const needle = params.query.toLowerCase();
        entries = entries.filter((entry) => entry.id.toLowerCase().includes(needle));
      }

      if (!params.include_variants) entries = dedupe(entries);

      const sortKey = (params.sort_by ?? "coding") as SortKey;
      entries.sort((a, b) => SORT_ACCESSORS[sortKey](b) - SORT_ACCESSORS[sortKey](a));
      entries = entries.slice(0, params.limit ?? 20);

      const ageHours = qualityAgeMs() !== undefined ? Math.round(qualityAgeMs()! / 3_600_000) : undefined;
      const headerNote = `Artificial Analysis dataset: ${qualityRecordCount()} models`
        + `${ageHours !== undefined ? `, refreshed ${ageHours}h ago` : ""}. Scores normalized to 0-100.`;

      const body = params.detail === "full"
        ? entries.map(formatFull).join("\n\n")
        : formatTable(entries);

      return {
        content: [{ type: "text", text: [headerNote, ...warnings, "", body].join("\n") }],
        details: { entries },
      };
    },
  });

  pi.registerCommand("models", {
    description: "Show available models ranked by benchmark data (models [coding|intelligence|agentic|cost|speed])",
    getArgumentCompletions: (prefix) =>
      Object.keys(SORT_ACCESSORS)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ value: key, label: key })),
    handler: async (args, ctx) => {
      await refreshQuality(false);
      await ensureFresh(ctx);
      const sortKey = (args.trim() || "coding") as SortKey;
      const key = SORT_ACCESSORS[sortKey] ? sortKey : "coding";
      const entries = dedupe((await ctx.modelRegistry.getAvailable()).map(buildEntry));
      entries.sort((a, b) => SORT_ACCESSORS[key](b) - SORT_ACCESSORS[key](a));
      ctx.ui.notify(`sorted by ${key}\n${formatTable(entries.slice(0, 25))}`, "info");
    },
  });

  pi.registerCommand("model-info", {
    description: "Benchmarks for one model id, or `refresh` / `setup`",
    getArgumentCompletions: (prefix) =>
      [
        { value: "refresh", label: "refresh: force a benchmark refresh" },
        { value: "setup", label: "setup: add the Artificial Analysis API key" },
      ].filter((option) => option.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const needle = args.trim().toLowerCase();

      if (needle === "setup") {
        const existing = env("ARTIFICIAL_ANALYSIS_API_KEY");

        if (existing && isFromProcessEnv("ARTIFICIAL_ANALYSIS_API_KEY")) {
          ctx.ui.notify(
            `ARTIFICIAL_ANALYSIS_API_KEY is set in your environment (${maskSecret(existing)}).\n`
            + "That always wins over stored settings. Unset it to manage the key here.",
            "warning",
          );
          return;
        }

        if (!ctx.hasUI) {
          ctx.ui.notify("Run /model-info setup in an interactive session.", "error");
          return;
        }

        ctx.ui.notify(
          [
            "Benchmark data comes from Artificial Analysis and needs a free API key.",
            "",
            "  1. Sign up at https://artificialanalysis.ai/insights/api",
            "  2. Copy your key (it looks like aa_…)",
            "",
            existing ? `A key is already stored (${maskSecret(existing)}). Entering a new one replaces it.` : "",
          ].filter(Boolean).join("\n"),
          "info",
        );

        const entered = await ctx.ui.input("Artificial Analysis API key", existing ? "leave blank to keep current" : "aa_…");
        if (entered === undefined) return;
        const key = entered.trim();
        if (!key) {
          ctx.ui.notify(existing ? "Kept the existing key." : "No key entered.", "info");
          return;
        }

        setEnv("ARTIFICIAL_ANALYSIS_API_KEY", key);
        ctx.ui.notify("Key saved. Verifying…", "info");

        const warnings = await refreshQuality(true);
        if (warnings.length > 0) {
          ctx.ui.notify(
            `Saved, but the key did not work:\n${warnings.join("\n")}\n\nRun /model-info setup again to replace it.`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(`Verified. ${qualityRecordCount()} models loaded from Artificial Analysis.`, "info");
        return;
      }

      if (needle === "refresh") {
        const warnings = await refreshQuality(true);
        const status = qualityStatus();
        const checked = status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : "never";
        const upstream = status.lastModified ? new Date(status.lastModified).toLocaleString() : "unknown";
        ctx.ui.notify(
          warnings.length > 0
            ? `Refresh issues:\n${warnings.join("\n")}`
            : [
                `Artificial Analysis: ${status.records} models`,
                `  checked:        ${checked}`,
                `  dataset dated:  ${upstream}`,
                `  revalidates:    every 4h via ETag`,
              ].join("\n"),
          warnings.length > 0 ? "warning" : "info",
        );
        return;
      }

      if (!needle) {
        ctx.ui.notify("Usage: /model-info <model id substring>, or /model-info refresh | setup", "warning");
        return;
      }

      await refreshQuality(false);
      await ensureFresh(ctx);
      const available = await ctx.modelRegistry.getAvailable();
      const model = available.find((candidate: any) =>
        `${candidate.provider}/${candidate.id}`.toLowerCase().includes(needle));
      if (!model) {
        ctx.ui.notify(`No available model matched “${needle}”.`, "error");
        return;
      }
      ctx.ui.notify(formatFull(buildEntry(model)), "info");
    },
  });
}
