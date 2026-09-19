import test from "node:test";
import assert from "node:assert/strict";
import { fitId, formatReset, formatShortReset, formatTokens, sanitize, themeLevel } from "../src/ui/format.ts";

test("formatTokens switches units at each magnitude", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(15_000), "15k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(15_000_000), "15M");
});

test("sanitize flattens control characters and collapses runs of spaces", () => {
  assert.equal(sanitize("a\nb\tc"), "a b c");
  assert.equal(sanitize("  lots    of   space  "), "lots of space");
});

test("fitId pads short ids and elides the middle of long ones", () => {
  assert.equal(fitId("abc", 10), "abc       ");
  const long = fitId("anthropic/claude-opus-5-with-a-very-long-suffix", 24);
  assert.equal(long.length, 24);
  assert.ok(long.includes("…"), "middle is elided, not the tail");
  assert.ok(long.endsWith("suffix"), "the distinguishing tail survives");
});

test("formatShortReset picks a single coarse unit", () => {
  const now = Date.now();
  assert.equal(formatShortReset(undefined), "");
  assert.equal(formatShortReset(now + 5 * 60_000), "5m");
  assert.equal(formatShortReset(now + 3 * 3_600_000), "3h");
  assert.equal(formatShortReset(now + 2 * 86_400_000), "2d");
  assert.equal(formatShortReset(now - 60_000), "1m", "past resets clamp rather than go negative");
});

test("formatReset spells out the two most significant units", () => {
  const now = Date.now();
  assert.equal(formatReset(undefined), "");
  assert.equal(formatReset(now + 30_000), "resets <1m");
  assert.equal(formatReset(now + 45 * 60_000), "resets 45m");
  assert.match(formatReset(now + 2 * 3_600_000 + 30 * 60_000), /^resets 2h \d+m$/);
  assert.match(formatReset(now + 3 * 86_400_000), /^resets 3d \d+h$/);
});

test("themeLevel escalates as quota drains", () => {
  assert.equal(themeLevel(100), "success");
  assert.equal(themeLevel(26), "success");
  assert.equal(themeLevel(25), "warning");
  assert.equal(themeLevel(11), "warning");
  assert.equal(themeLevel(10), "error");
  assert.equal(themeLevel(0), "error");
});
