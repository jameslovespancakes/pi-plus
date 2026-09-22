import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS as PI_ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { ANTHROPIC_MODELS } from "../src/core/anthropic/models.ts";

/**
 * `registerProvider("anthropic", { models })` substitutes pi's catalogue
 * rather than extending it, so anything missing from this list vanishes from
 * the model picker with no error. The catalogue must therefore be a superset
 * of pi's.
 */

const pi = Object.values(PI_ANTHROPIC_MODELS as unknown as Record<string, Model<"anthropic-messages">>);
const byId = new Map(ANTHROPIC_MODELS.map((model) => [model.id, model]));

test("no model pi knows about is dropped", () => {
  const missing = pi.map((model) => model.id).filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `these would disappear from the picker: ${missing.join(", ")}`);
});

test("pi-plus-only models are still offered", () => {
  for (const id of ["claude-mythos-5", "claude-mythos-5-1"]) {
    assert.ok(byId.has(id), `${id} missing`);
  }
});

test("corrections replace only the fields they name", () => {
  const source = pi.find((model) => model.id === "claude-opus-5")!;
  const merged = byId.get("claude-opus-5")!;

  assert.equal(merged.contextWindow, 1_000_000);
  assert.equal(merged.maxTokens, 128_000);
  assert.deepEqual(merged.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  // Everything pi knows that the correction does not mention survives.
  assert.equal(merged.name, source.name);
  assert.deepEqual((merged as any).thinkingLevelMap, (source as any).thinkingLevelMap);
});

test("every entry is complete enough to register", () => {
  for (const model of ANTHROPIC_MODELS) {
    assert.ok(model.id && model.name, model.id);
    assert.ok(model.contextWindow > 0 && model.maxTokens > 0, model.id);
    assert.ok(model.cost && typeof model.cost.input === "number", model.id);
    assert.ok(Array.isArray(model.input) && model.input.length > 0, model.id);
  }
  assert.equal(new Set(ANTHROPIC_MODELS.map((m) => m.id)).size, ANTHROPIC_MODELS.length, "duplicate ids");
});
