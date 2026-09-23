import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_FRESH_MS, combinedWindow, isFresh } from "../src/core/quota/pool.ts";
import { renderUsageLines } from "../src/ui/usage-bars.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const now = Date.now();

const rows = [
  { group: "Claude A", label: "5h", remaining: 60, checkedAt: now, resetAt: now + 3600_000 },
  { group: "Claude B", label: "5h", remaining: 80, checkedAt: now, resetAt: now + 3600_000 },
  { group: "Claude A", label: "7d", remaining: 40, checkedAt: now, resetAt: now + 86400_000 },
  { group: "Claude B", label: "7d", remaining: 50, checkedAt: now, resetAt: now + 86400_000 },
  // A scoped per-model limit that only one account reports.
  { group: "Claude A", label: "7d claude-weekly-scoped-fable", remaining: 66, checkedAt: now, resetAt: now + 86400_000 },
];

const state = { loading: false, rows, errors: [], accounts: 2, lastUsedAt: {} } as any;

test("the scoped limit gets no bar row", () => {
  // Its label is an internal id that truncated to "claude" at the 6 column
  // label width, and it pooled as n/a whenever one account was excluded.
  const lines = renderUsageLines(state, theme, 100);
  assert.ok(!lines.some((l) => /\bclaude\s+[·.]/.test(l)), "no row labelled from the scoped id");
  assert.ok(!lines.some((l) => l.includes("scoped")), "the raw id never reaches the bars");
});

test("the real windows still render with values", () => {
  const lines = renderUsageLines(state, theme, 100);
  const joined = lines.join("\n");
  assert.match(joined, /5h/);
  assert.match(joined, /weekly/);
  assert.match(joined, /2\/2 ready/, "both accounts pool");
  assert.doesNotMatch(lines[0] ?? "", /\bpartial\b/, "footer title stays concise");
  // Each line carries Claude on the left and Codex on the right, so assert
  // against the Claude half only: Codex is legitimately n/a with no accounts.
  // Escapes must be stripped first, or the midpoint lands inside a colour
  // sequence rather than halfway across the visible row.
  const claudeHalf = (line: string) => {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
    return plain.slice(0, Math.floor(plain.length / 2));
  };
  assert.match(claudeHalf(lines[1] ?? ""), /\d+%/, "Claude 5h shows a percentage");
  assert.match(claudeHalf(lines[2] ?? ""), /\d+%/, "Claude weekly shows a percentage");
});

const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
/**
 * The right-hand column of a 100-wide line. The Claude half ends by column 49
 * and the gap is three spaces, so column 50 always falls inside the gap.
 */
const rightHalf = (line: string) => plain(line).slice(50).trimStart();

const geminiRows = [
  { group: "Gemini Primary", label: "Flash", remaining: 99, checkedAt: now, resetAt: now + 6 * 86400_000 },
  { group: "Gemini Primary", label: "Pro", remaining: 80, checkedAt: now, resetAt: now + 6 * 86400_000 },
  { group: "Gemini Primary", label: "Claude", remaining: 100, checkedAt: now, resetAt: now + 7 * 86400_000 },
  { group: "Gemini Primary", label: "GPT", remaining: 60, checkedAt: now, resetAt: now + 7 * 86400_000 },
];
const codexRows = [{ group: "Codex", label: "weekly", remaining: 18, checkedAt: now, resetAt: now + 3 * 86400_000 }];
const mixed = { ...state, rows: [...rows, ...codexRows, ...geminiRows], geminiAccounts: 1, codexPlan: "pro" };

test("the right column shows Codex while Claude is in use", () => {
  const lines = renderUsageLines(mixed, theme, 100, { provider: "anthropic", modelId: "claude-opus-5-5" });
  assert.match(rightHalf(lines[0]), /^Codex \u00b7 pro/);
  assert.match(rightHalf(lines[2]), /weekly .* 18%/);
});

test("the right column swaps to Gemini while a Gemini model is in use", () => {
  const lines = renderUsageLines(mixed, theme, 100, { provider: "gemini", modelId: "gemini-3.8-flash" });
  assert.match(rightHalf(lines[0]), /^Gemini \u00b7 1\/1 ready/);
  assert.match(rightHalf(lines[1]), /^Flash .* 99%/);
  assert.match(rightHalf(lines[2]), /^Pro .* 80%/);
  assert.match(rightHalf(lines[3]), /^Claude .* 100%/);
  assert.match(plain(lines[0]), /^ {2}Claude \u03a32/, "Claude keeps the left column");
});

test("Gemini's third bar follows the third-party family in use", () => {
  const lines = renderUsageLines(mixed, theme, 100, { provider: "gemini", modelId: "gpt-oss-120b" });
  assert.match(rightHalf(lines[3]), /^GPT .* 60%/);
});

test("the active Gemini family is highlighted", () => {
  const marking = { fg: (color: string, text: string) => (color === "accent" ? `[${text.trim()}]` : text), bold: (t: string) => t };
  const lines = renderUsageLines(mixed, marking, 100, { provider: "gemini", modelId: "gemini-3.1-pro" });
  assert.ok(lines.some((line) => line.includes("[Pro]")), "Pro is the active family");
  assert.ok(!lines.some((line) => line.includes("[Flash]")), "Flash is not");
});

test("a Claude model served through Gemini does not steer the Claude column", () => {
  const lines = renderUsageLines(mixed, theme, 100, { provider: "gemini", modelId: "claude-opus-4-6" });
  assert.match(rightHalf(lines[3]), /^Claude .* 100%/, "Gemini's Claude allowance");
});

test("providers without a usage endpoint say so rather than showing Codex", () => {
  const lines = renderUsageLines(mixed, theme, 100, { provider: "xai", modelId: "grok-5" });
  assert.match(rightHalf(lines[0]), /^Grok \u00b7 usage not reported/);

  const observed = { ...mixed, rows: [...mixed.rows, { group: "Kimi", label: "rate", remaining: 0, checkedAt: now, resetAt: now + 60_000 }] };
  const kimi = renderUsageLines(observed, theme, 100, { provider: "kimi-coding", modelId: "k2" });
  assert.match(rightHalf(kimi[0]), /^Kimi/);
  assert.match(rightHalf(kimi[1]), /^rate .* 0%/);
});

test("with no Codex figures the default column is Gemini's", () => {
  const noCodex = { ...mixed, rows: [...rows, ...geminiRows] };
  const lines = renderUsageLines(noCodex, theme, 100, { provider: "anthropic", modelId: "claude-opus-5-5" });
  assert.match(rightHalf(lines[0]), /^Gemini/);
});

test("a row without checkedAt is never fresh", () => {
  // Regression: cached rows built from a stored snapshot omitted checkedAt,
  // so isFresh rejected every one and the whole HUD read "unknown/stale".
  assert.equal(isFresh({ group: "Claude A", label: "5h", remaining: 50 }, now), false);
  assert.equal(isFresh({ group: "Claude A", label: "5h", remaining: 50, checkedAt: now }, now), true);
});

test("the freshness window exceeds the 10 minute poll interval", () => {
  // Idle accounts are polled at most once per 10 minutes. A shorter freshness
  // bound would mark them stale almost always.
  assert.ok(CLAUDE_FRESH_MS > 10 * 60_000, `expected > 10min, got ${CLAUDE_FRESH_MS}ms`);
});

test("pooling needs every account, unless partial is allowed", () => {
  const oneOnly = rows.filter((r) => r.group === "Claude A" && r.label === "5h");
  assert.equal(combinedWindow(oneOnly, "5h", 2, now), undefined, "1 of 2 does not pool");
  assert.ok(combinedWindow(oneOnly, "5h", 2, now, true)?.partial, "partial is marked");
});
