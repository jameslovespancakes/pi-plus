import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_FRESH_MS,
  combinedWindow,
  isClaudeAccount,
  isFresh,
  poolAvailability,
  scopedLabels,
  type UsageRow,
} from "../src/core/quota/pool.ts";

const NOW = 1_700_000_000_000;

function row(overrides: Partial<UsageRow> & { group: string; label: string; remaining: number }): UsageRow {
  return { checkedAt: NOW, ...overrides };
}

test("isClaudeAccount excludes synthetic pool rows", () => {
  assert.equal(isClaudeAccount(row({ group: "Claude Personal", label: "5h", remaining: 50 })), true);
  assert.equal(isClaudeAccount(row({ group: "Claude pool ×3", label: "5h", remaining: 50 })), false);
  assert.equal(isClaudeAccount(row({ group: "Codex", label: "5h", remaining: 50 })), false);
});

test("isFresh rejects stale, old, and already-reset rows", () => {
  assert.equal(isFresh(row({ group: "Claude A", label: "5h", remaining: 50 }), NOW), true);
  assert.equal(isFresh(row({ group: "Claude A", label: "5h", remaining: 50, stale: true }), NOW), false);
  assert.equal(isFresh(row({ group: "Claude A", label: "5h", remaining: 50, checkedAt: undefined }), NOW), false);
  assert.equal(
    isFresh(row({ group: "Claude A", label: "5h", remaining: 50, checkedAt: NOW - CLAUDE_FRESH_MS - 1 }), NOW),
    false,
    "past the freshness window",
  );
  assert.equal(
    isFresh(row({ group: "Claude A", label: "5h", remaining: 50, resetAt: NOW - 1 }), NOW),
    false,
    "window already reset, figure is meaningless",
  );
});

test("combinedWindow averages equally when no capacities are published", () => {
  const rows = [
    row({ group: "Claude A", label: "5h", remaining: 80 }),
    row({ group: "Claude B", label: "5h", remaining: 20 }),
  ];
  const result = combinedWindow(rows, "5h", 2, NOW);
  assert.ok(result);
  assert.equal(result.remaining, 50);
  assert.equal(result.estimated, true, "equal-account estimate, not a capacity-weighted figure");
  assert.equal(result.partial, false);
});

test("combinedWindow weights by capacity when every row publishes one", () => {
  const rows = [
    row({ group: "Claude A", label: "5h", remaining: 100, capacity: 30 }),
    row({ group: "Claude B", label: "5h", remaining: 0, capacity: 10 }),
  ];
  const result = combinedWindow(rows, "5h", 2, NOW);
  assert.ok(result);
  assert.equal(result.remaining, 75, "30/40 of capacity is full");
  assert.equal(result.estimated, false);
});

test("combinedWindow withholds partial results unless explicitly allowed", () => {
  const rows = [row({ group: "Claude A", label: "5h", remaining: 80 })];
  assert.equal(combinedWindow(rows, "5h", 3, NOW), undefined, "1 of 3 accounts reporting");
  const permitted = combinedWindow(rows, "5h", 3, NOW, true);
  assert.ok(permitted);
  assert.equal(permitted.partial, true);
});

test("combinedWindow returns undefined when nothing matches", () => {
  assert.equal(combinedWindow([], "5h", 0, NOW), undefined);
  assert.equal(combinedWindow([], "5h", 2, NOW, true), undefined);
});

test("combinedWindow reports the soonest future reset", () => {
  const rows = [
    row({ group: "Claude A", label: "5h", remaining: 50, resetAt: NOW + 9_000 }),
    row({ group: "Claude B", label: "5h", remaining: 50, resetAt: NOW + 3_000 }),
  ];
  assert.equal(combinedWindow(rows, "5h", 2, NOW)?.resetAt, NOW + 3_000);
});

test("scopedLabels sorts the active model's family first", () => {
  const rows = [
    row({ group: "Claude A", label: "7d Sonnet", remaining: 50 }),
    row({ group: "Claude A", label: "7d Opus", remaining: 50 }),
    row({ group: "Claude A", label: "5h", remaining: 50 }),
  ];
  assert.deepEqual(scopedLabels(rows, "claude-opus-5"), ["7d Opus", "7d Sonnet"]);
  assert.deepEqual(scopedLabels(rows, "claude-sonnet-5"), ["7d Sonnet", "7d Opus"]);
  assert.deepEqual(scopedLabels(rows), ["7d Opus", "7d Sonnet"], "alphabetical without a model hint");
});

test("scopedLabels maps the mythos model id onto the fable window", () => {
  const rows = [row({ group: "Claude A", label: "7d Fable", remaining: 50 })];
  assert.deepEqual(scopedLabels(rows, "claude-mythos-5-1"), ["7d Fable"]);
});

test("poolAvailability requires every applicable window to pass", () => {
  const rows = [
    row({ group: "Claude A", label: "5h", remaining: 50 }),
    row({ group: "Claude A", label: "7d", remaining: 50 }),
    row({ group: "Claude B", label: "5h", remaining: 0 }),
    row({ group: "Claude B", label: "7d", remaining: 90 }),
  ];
  const result = poolAvailability(rows, 2, undefined, NOW);
  assert.equal(result.ready, 1, "B is exhausted on 5h despite a healthy weekly window");
  assert.equal(result.unknown, 0);
  assert.equal(result.total, 2);
});

test("poolAvailability counts missing and stale accounts as unknown", () => {
  const rows = [
    row({ group: "Claude A", label: "5h", remaining: 50 }),
    row({ group: "Claude A", label: "7d", remaining: 50, stale: true }),
  ];
  const result = poolAvailability(rows, 3, undefined, NOW);
  assert.equal(result.ready, 0, "A has a stale required window");
  assert.equal(result.unknown, 3, "1 stale + 2 never reported");
});

test("recentAccounts orders by observed use and caps the list", async () => {
  process.env.PI_AGENT_DIR = join(tmpdir(), `pi-plus-recent-${Math.random()}`);
  const service = await import(`../src/services/usage-service.ts?case=${Math.random()}`);
  const state = service.usageState();

  state.rows = [
    { group: "Claude Work", label: "5h", remaining: 50, checkedAt: Date.now() },
    { group: "Claude Personal", label: "5h", remaining: 80, checkedAt: Date.now() },
    { group: "Claude Spare", label: "5h", remaining: 90, checkedAt: Date.now() },
    { group: "Codex", label: "5h", remaining: 70, checkedAt: Date.now() },
  ];
  state.lastUsedAt = { "Claude Spare": 300, "Claude Work": 200, "Claude Personal": 100 };

  assert.deepEqual(service.recentAccounts(2), ["Claude Spare", "Claude Work"], "most recent first, Codex excluded");
  assert.equal(service.recentAccounts(10).length, 3, "only Claude accounts are listed");

  state.lastUsedAt = {};
  assert.deepEqual(
    service.recentAccounts(2),
    ["Claude Personal", "Claude Spare"],
    "unused accounts fall back to alphabetical for stability",
  );
});
