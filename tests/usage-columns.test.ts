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
