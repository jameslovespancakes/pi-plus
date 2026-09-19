import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQuotaHeaders,
  parseQuota,
  isPollBlocked,
  resetPollBackoff,
  isFresh,
  QUOTA_FRESH_MS,
} from "../src/core/anthropic/quota.ts";

/** Real headers captured from a live /v1/messages reply. */
const LIVE = {
  "anthropic-ratelimit-unified-5h-utilization": "0.16",
  "anthropic-ratelimit-unified-5h-reset": "1789838400",
  "anthropic-ratelimit-unified-7d-utilization": "0.74",
  "anthropic-ratelimit-unified-7d-status": "allowed",
};

test("headers are scaled from fraction to percent", () => {
  // The endpoint reports 16; the header reports 0.16. Routing compares the two
  // sources, so dropping this x100 would make header-fed accounts look ~100x
  // less used and win every routing decision.
  const q = parseQuotaHeaders(LIVE)!;
  assert.equal(q.five_hour?.usedPercent, 16);
  assert.equal(q.seven_day?.usedPercent, 74);
  assert.equal(q.five_hour?.remainingPercent, 84);
});

test("header and poll snapshots agree for the same account state", () => {
  // Captured together from one account: header 0.16/0.74, endpoint 16/74.
  const fromHeaders = parseQuotaHeaders(LIVE)!;
  const fromPoll = parseQuota({ five_hour: { utilization: 16 }, seven_day: { utilization: 74 } });
  assert.equal(fromHeaders.five_hour?.usedPercent, fromPoll.five_hour?.usedPercent);
  assert.equal(fromHeaders.seven_day?.usedPercent, fromPoll.seven_day?.usedPercent);
});

test("reset seconds become an ISO timestamp", () => {
  const q = parseQuotaHeaders(LIVE)!;
  assert.equal(q.five_hour?.resetsAt, new Date(1789838400 * 1000).toISOString());
});

test("the snapshot records where it came from", () => {
  assert.equal(parseQuotaHeaders(LIVE)!.source, "headers");
});

test("header casing does not matter", () => {
  const upper = { "ANTHROPIC-RATELIMIT-UNIFIED-5H-UTILIZATION": "0.5" };
  assert.equal(parseQuotaHeaders(upper)?.five_hour?.usedPercent, 50);
});

test("absent or unparsable headers yield undefined, not a zeroed snapshot", () => {
  // A zeroed snapshot would read as "0% used" and attract all routing.
  assert.equal(parseQuotaHeaders(undefined), undefined);
  assert.equal(parseQuotaHeaders({}), undefined);
  assert.equal(parseQuotaHeaders({ "content-type": "application/json" }), undefined);
  assert.equal(parseQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "n/a" }), undefined);
});

test("one window alone is still usable", () => {
  const q = parseQuotaHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.9" })!;
  assert.equal(q.seven_day?.usedPercent, 90);
  assert.equal(q.five_hour, undefined);
});

test("utilisation is clamped to 0-100", () => {
  assert.equal(parseQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "1.5" })!.five_hour?.usedPercent, 100);
  assert.equal(parseQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "-1" })!.five_hour?.usedPercent, 0);
});

test("poll backoff starts clear and is resettable", () => {
  resetPollBackoff();
  assert.equal(isPollBlocked("any-account"), false);
});

test("the freshness window is the poll rate limiter", () => {
  // Polling is driven by message sends, so this constant is the only thing
  // bounding the rate. Ten minutes: sending faster than that must not poll
  // more often than that.
  assert.equal(QUOTA_FRESH_MS, 10 * 60_000);
});

test("a fresh snapshot suppresses re-polling; a stale one allows it", () => {
  const now = Date.now();
  assert.equal(isFresh({ checkedAt: now }, now), true, "just checked");
  assert.equal(isFresh({ checkedAt: now - 60_000 }, now), true, "1 min old, inside window");
  assert.equal(isFresh({ checkedAt: now - (QUOTA_FRESH_MS - 1_000) }, now), true, "just inside");
  assert.equal(isFresh({ checkedAt: now - (QUOTA_FRESH_MS + 1_000) }, now), false, "just outside");
  assert.equal(isFresh(undefined, now), false, "never checked must poll");
});
