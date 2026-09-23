import test from "node:test";
import assert from "node:assert/strict";
import { fetchUserQuota } from "../src/core/gemini/client.ts";
import { geminiQuotaFamily, summarizeGeminiQuota } from "../src/core/gemini/quota.ts";

test("public and runtime ids map onto the family that pools their quota", () => {
  assert.equal(geminiQuotaFamily("gemini-3.8-flash"), "Flash");
  assert.equal(geminiQuotaFamily("gemini-3.8-flash-high"), "Flash");
  assert.equal(geminiQuotaFamily("gemini-3-flash-agent"), "Flash");
  assert.equal(geminiQuotaFamily("gemini-3.1-pro"), "Pro");
  assert.equal(geminiQuotaFamily("gemini-pro-agent"), "Pro");
  assert.equal(geminiQuotaFamily("claude-opus-4-6"), "Claude");
  assert.equal(geminiQuotaFamily("claude-opus-4-6-thinking"), "Claude");
  assert.equal(geminiQuotaFamily("gpt-oss-120b-medium"), "GPT");
});

test("helper, tab and image models never count toward a family", () => {
  for (const id of ["chat_20706", "tab_flash_lite_preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-image", undefined]) {
    assert.equal(geminiQuotaFamily(id), undefined, String(id));
  }
});

test("each family reports its most depleted bucket", () => {
  const families = summarizeGeminiQuota([
    { modelId: "gemini-3.8-flash-high", remainingFraction: 0.9, resetTime: "2026-09-29T17:43:59Z" },
    { modelId: "gemini-3.8-flash-low", remainingFraction: 0.4, resetTime: "2026-09-29T17:43:59Z" },
    { modelId: "gemini-pro-agent", remainingFraction: 1, resetTime: "2026-09-30T00:00:00Z" },
    { modelId: "claude-sonnet-4-6", remainingFraction: 0.25 },
    // A helper that has run dry must not drag Flash down with it.
    { modelId: "gemini-3.5-flash-lite", remainingFraction: 0 },
    { modelId: "chat_20706", remainingFraction: 0 },
  ]);
  assert.deepEqual(families.map((family) => [family.family, Math.round(family.remaining)]), [
    ["Flash", 40],
    ["Pro", 100],
    ["Claude", 25],
  ]);
  assert.equal(families[0].resetAt, Date.parse("2026-09-29T17:43:59Z"));
  assert.equal(families[2].resetAt, undefined);
});

test("quota falls through endpoints and reads an omitted fraction as exhausted", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(String(url));
    assert.deepEqual(JSON.parse(String(init.body)), { project: "project-1" });
    if (calls.length === 1) return new Response("unavailable", { status: 503 });
    return Response.json({
      buckets: [
        { modelId: "gemini-3.8-flash-high", remainingFraction: 0.5, resetTime: "2026-09-29T17:43:59Z" },
        // proto3 drops zero values: this is how an empty bucket arrives.
        { modelId: "gemini-pro-agent", resetTime: "2026-09-29T17:43:59Z" },
        { modelId: 42 },
      ],
    });
  }) as typeof fetch;
  try {
    const buckets = await fetchUserQuota("ya29.token", "project-1");
    assert.equal(calls.length, 2, "the failing endpoint is skipped, the next one answers");
    assert.match(calls[0], /retrieveUserQuota$/);
    assert.deepEqual(buckets, [
      { modelId: "gemini-3.8-flash-high", remainingFraction: 0.5, resetTime: "2026-09-29T17:43:59Z" },
      { modelId: "gemini-pro-agent", remainingFraction: 0, resetTime: "2026-09-29T17:43:59Z" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("quota throws when no endpoint answers", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  try {
    await assert.rejects(fetchUserQuota("ya29.token", "project-1"), /did not return quota/);
  } finally {
    globalThis.fetch = original;
  }
});
