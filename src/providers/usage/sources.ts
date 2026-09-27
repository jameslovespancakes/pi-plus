import { fetchClaudeRows } from "../anthropic/usage.ts";
import { fetchCodexRows } from "../codex/usage.ts";
import { fetchGeminiRows } from "../gemini/usage.ts";
import { observedRows } from "./observed.ts";
import type { UsageRow } from "../shared/quota/pool.ts";
import type { SourceOptions } from "../shared/quota/source.ts";

export interface SourceResult {
  rows: UsageRow[];
  errors: string[];
  /** Claude account groups expected to report. */
  groups: string[];
  /** Gemini account groups expected to report. */
  geminiGroups: string[];
  codexPlan?: string;
}

/** One full poll of every configured subscription source. */
export async function fetchAll(ctx: any, options: SourceOptions = {}): Promise<SourceResult> {
  const [claude, codex, gemini] = await Promise.all([
    fetchClaudeRows(ctx, options),
    fetchCodexRows(ctx, options),
    fetchGeminiRows(ctx, options),
  ]);
  return {
    rows: [...claude.rows, ...codex.rows, ...gemini.rows, ...observedRows()],
    errors: [...claude.errors, codex.error, ...gemini.errors].filter((error): error is string => !!error),
    groups: claude.groups,
    geminiGroups: gemini.groups,
    codexPlan: codex.plan,
  };
}
