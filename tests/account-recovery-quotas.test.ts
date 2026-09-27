import test from "node:test";
import assert from "node:assert/strict";
import { accountRetryAt } from "../src/providers/shared/accounts/provider-errors.ts";
import { quotaStateFromHeaders, quotaStateFromWindows, selectRoutingCandidate } from "../src/providers/shared/accounts/routing.ts";
import { routingQuota, selectAccount } from "../src/providers/anthropic/routing.ts";

const now = 1_800_000_000_000;
const iso = (delay: number) => new Date(now + delay).toISOString();

test("Retry-After seconds, HTTP dates, and text hints are honored without adding a default minute", () => {
  assert.equal(accountRetryAt({ "Retry-After": "10" }, "", now), now + 10000);
  assert.equal(accountRetryAt({ "Retry-After": new Date(now + 25000).toUTCString() }, "", now), now + 25000);
  assert.equal(accountRetryAt({}, "try again in 10 seconds", now), now + 10000);
  assert.equal(accountRetryAt({ "retry-after": "10" }, "resets in 1 hour", now), now + 3_600_000);
  assert.equal(accountRetryAt({}, "", now), now + 10000);
});

test("a temporary 429 cannot erase a longer or unknown exhausted quota window", () => {
  const hard = { remainingPercent: 0, resetAt: now + 3_600_000, checkedAt: now };
  assert.equal(quotaStateFromHeaders(429, { "retry-after": "10" }, hard, now)?.resetAt, hard.resetAt);
  const unknown = { remainingPercent: 0, checkedAt: now };
  const observed = quotaStateFromHeaders(429, {}, unknown, now);
  assert.equal(selectRoutingCandidate([{ id: "one", order: 0, lastUsed: 0, quota: observed, value: true }], "sequential", now + 95000), undefined);
  const temporary = quotaStateFromHeaders(429, {}, undefined, now);
  assert.ok(selectRoutingCandidate([{ id: "one", order: 0, lastUsed: 0, quota: temporary, value: true }], "sequential", now + 95000));
});

test("successful concurrent responses do not clear an active request cooldown", () => {
  const blocked = quotaStateFromHeaders(429, { "retry-after": "60" }, undefined, now);
  const updated = quotaStateFromHeaders(200, { "x-ratelimit-remaining": "90" }, blocked, now + 1000);
  assert.equal(updated?.remainingPercent, 90);
  assert.equal(updated?.blockedUntil, now + 60000);
});

test("all exhausted windows must reset, not just the earliest one", () => {
  const windows = [{ remainingPercent: 0, resetAt: now + 10000 }, { remainingPercent: 0, resetAt: now + 60000 }];
  assert.equal(quotaStateFromWindows(windows, now, now)?.resetAt, now + 60000);
  assert.equal(quotaStateFromWindows(windows, now, now + 25000)?.remainingPercent, 0);
  assert.equal(quotaStateFromWindows(windows, now, now + 61000), undefined);
  assert.equal(quotaStateFromWindows([...windows, { remainingPercent: 0, resetAt: undefined }], now, now)?.resetAt, undefined);
});

test("Claude scoped windows match model display names and do not block unrelated models", () => {
  const quota = { checkedAt: now, five_hour: { remainingPercent: 90 }, seven_day: { remainingPercent: 80 }, scoped: [
    { id: "Claude Opus 5.5", remainingPercent: 0, resetsAt: iso(60000) },
    { id: "opus", remainingPercent: 0, resetsAt: iso(120000) },
    { id: "mythos", remainingPercent: 0, resetsAt: iso(180000) },
  ] };
  assert.equal(routingQuota(quota, "opus", "claude-opus-5-5", now)?.resetAt, now + 120000);
  assert.equal(routingQuota(quota, "general", "claude-sonnet-4-6", now)?.remainingPercent, 80);
  assert.equal(routingQuota(quota, "fable", "claude-fable-5", now)?.resetAt, now + 180000);
  assert.equal(routingQuota(quota, "fable", "claude-mythos-5", now)?.remainingPercent, 0);
});

test("a single exhausted Claude candidate is not a fallback and a reset short window cannot bypass weekly exhaustion", () => {
  const candidates = [{ id: "only", access: "token", order: 0, quota: {
    five_hour: { remainingPercent: 0, resetsAt: iso(-1000) }, seven_day: { remainingPercent: 0, resetsAt: iso(60000) },
  } }];
  assert.equal(selectAccount({ candidates, family: "opus", modelId: "claude-opus-5-5", mode: "sequential", now }), undefined);
  assert.equal(selectAccount({ candidates, family: "opus", modelId: "claude-opus-5-5", mode: "sequential", now: now + 61000 })?.candidate.id, "only");
});
