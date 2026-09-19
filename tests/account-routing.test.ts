import test from "node:test";
import assert from "node:assert/strict";
import { quotaStateFromHeaders, selectRoutingCandidate } from "../src/core/accounts/routing.ts";
import { selectAccount } from "../src/core/anthropic/routing.ts";

const candidate = (
  id: string,
  order: number,
  remainingPercent?: number,
  lastUsed = 0,
  blockedUntil?: number,
) => ({
  id,
  order,
  lastUsed,
  quota: remainingPercent === undefined ? undefined : { remainingPercent, checkedAt: 1, blockedUntil },
  value: id,
});

test("sequential routing uses account order and skips blocked accounts", () => {
  const now = 1_000;
  const selected = selectRoutingCandidate([
    candidate("one", 0, 0, 0, now + 60_000),
    candidate("two", 1, 80),
  ], "sequential", now);
  assert.equal(selected?.value, "two");
});

test("routing returns no candidate when every account is blocked", () => {
  const now = 1_000;
  const selected = selectRoutingCandidate([
    candidate("one", 0, 0, 0, now + 60_000),
    candidate("two", 1, 0, 0, now + 60_000),
  ], "sequential", now);
  assert.equal(selected, undefined);
});

test("quota-aware routing measures unknown accounts before choosing most remaining", () => {
  const unknown = selectRoutingCandidate([
    candidate("one", 0, 90, 20),
    candidate("two", 1, undefined, 10),
  ], "quota-aware");
  assert.equal(unknown?.value, "two");

  const measured = selectRoutingCandidate([
    candidate("one", 0, 45),
    candidate("two", 1, 80),
  ], "quota-aware");
  assert.equal(measured?.value, "two");
});

test("Claude sequential routing can fall back to an unmeasured account", () => {
  const selected = selectAccount({
    family: "general",
    mode: "sequential",
    candidates: [
      {
        id: "one",
        access: "one",
        order: 0,
        quota: {
          five_hour: { remainingPercent: 0, resetsAt: new Date(Date.now() + 60_000).toISOString() },
          seven_day: { remainingPercent: 80 },
        },
      },
      { id: "two", access: "two", order: 1 },
    ],
  });
  assert.equal(selected?.candidate.id, "two");
});

test("Claude quota-aware routing uses the account with more capacity", () => {
  const selected = selectAccount({
    family: "general",
    mode: "quota-aware",
    candidates: [
      { id: "one", access: "one", order: 0, quota: { five_hour: { remainingPercent: 30 }, seven_day: { remainingPercent: 40 } } },
      { id: "two", access: "two", order: 1, quota: { five_hour: { remainingPercent: 70 }, seven_day: { remainingPercent: 80 } } },
    ],
  });
  assert.equal(selected?.candidate.id, "two");
});

test("rate-limit headers block an account until retry-after", () => {
  const now = 10_000;
  assert.deepEqual(quotaStateFromHeaders(429, { "retry-after": "30" }, undefined, now), {
    remainingPercent: 0,
    resetAt: 40_000,
    checkedAt: now,
    blockedUntil: 40_000,
  });
});

test("request quota headers are normalized to remaining percent", () => {
  assert.deepEqual(quotaStateFromHeaders(200, {
    "x-ratelimit-remaining-requests": "25",
    "x-ratelimit-limit-requests": "100",
  }, undefined, 5), {
    remainingPercent: 25,
    resetAt: undefined,
    checkedAt: 5,
  });
});
