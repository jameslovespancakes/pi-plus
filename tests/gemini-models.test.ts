import test from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GEMINI_ENDPOINT } from "../src/core/gemini/client.ts";
import {
  GEMINI_API,
  GEMINI_PROVIDER,
  STATIC_MODELS,
  buildCatalog,
  humanizeModelId,
  isSelectableRuntimeId,
  runtimeModelId,
  thinkingConfig,
  withStaticModels,
} from "../src/core/gemini/models.ts";

const byId = (id: string) => STATIC_MODELS.find((model) => model.id === id)!;
const routes = (model: Model<Api>) =>
  Object.fromEntries(getSupportedThinkingLevels(model).map((level) => [level, runtimeModelId(model, level)]));

/**
 * The routing table is the part of this provider that cannot be derived from
 * anywhere: the backend's display labels do not match its runtime ids. It is
 * pinned here against the table `pi-antigravity` verified live.
 */
test("public models route each advertised thinking level to its runtime id", () => {
  assert.deepEqual(routes(byId("gemini-3.8-flash")), {
    low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high",
  });
  assert.deepEqual(routes(byId("gemini-3.5-flash")), {
    low: "gemini-3.5-flash-extra-low", medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent",
  });
  assert.deepEqual(routes(byId("gemini-3.1-pro")), { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" });
  assert.deepEqual(routes(byId("claude-opus-4-6")), { high: "claude-opus-4-6-thinking" });
  assert.deepEqual(routes(byId("claude-sonnet-4-6")), { high: "claude-sonnet-4-6" });
  assert.deepEqual(routes(byId("gpt-oss-120b")), { medium: "gpt-oss-120b-medium" });
});

test("thinking off is served by the lightest variant, never the public id", () => {
  assert.equal(runtimeModelId(byId("gemini-3.8-flash")), "gemini-3.8-flash-low");
  assert.equal(runtimeModelId(byId("gemini-3.8-flash"), "off"), "gemini-3.8-flash-low");
  assert.equal(runtimeModelId(byId("gemini-3.1-pro")), "gemini-3.1-pro-low");
  // A level the model does not advertise also falls back rather than 404ing.
  assert.equal(runtimeModelId(byId("gpt-oss-120b"), "high"), "gpt-oss-120b-medium");
});

test("every static model is a free, reasoning Gemini model with pi-readable levels", () => {
  for (const model of STATIC_MODELS) {
    assert.equal(model.api, GEMINI_API, model.id);
    assert.equal(model.provider, GEMINI_PROVIDER, model.id);
    assert.equal(model.baseUrl, GEMINI_ENDPOINT, model.id);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model.id);
    assert.equal(model.reasoning, true, model.id);
    // `off` is hidden: every runtime id thinks; off is sent as budget zero.
    assert.ok(!getSupportedThinkingLevels(model).includes("off"), model.id);
    assert.ok(model.name && !model.name.includes("("), model.id);
  }
});

test("facts pi already knows come from pi's catalogue, capped at the backend's output limit", () => {
  const google = GOOGLE_MODELS as unknown as Record<string, Model<Api>>;
  for (const model of STATIC_MODELS.filter((candidate) => google[candidate.id])) {
    assert.equal(model.contextWindow, google[model.id].contextWindow, model.id);
    assert.deepEqual(model.input, google[model.id].input, model.id);
    assert.ok(model.maxTokens <= 65_536, model.id);
  }
  assert.equal(byId("gemini-3.1-pro").maxTokens, 65_535);
  assert.equal(byId("claude-opus-4-6").maxTokens, 64_000);
  assert.deepEqual(byId("gpt-oss-120b").input, ["text"]);
});

test("thinking budgets follow the Antigravity CLI wire format per runtime family", () => {
  const budget = (runtime: string, level?: any) => thinkingConfig(runtime, level)?.thinkingBudget;
  assert.deepEqual([budget("gemini-3.8-flash-low", "low"), budget("gemini-3.8-flash-medium", "medium"), budget("gemini-3.8-flash-high", "high")], [1000, 4000, -1]);
  assert.deepEqual([budget("gemini-3.5-flash-low", "medium"), budget("gemini-3-flash-agent", "high")], [4000, 10_000]);
  assert.deepEqual([budget("gemini-3.1-pro-low", "low"), budget("gemini-pro-agent", "high")], [1001, 10_001]);
  assert.equal(budget("claude-opus-4-6-thinking", "high"), 1024);
  assert.equal(budget("gpt-oss-120b-medium", "medium"), 8192);

  assert.deepEqual(thinkingConfig("gemini-3.8-flash-low"), { includeThoughts: false, thinkingBudget: 0 });
  assert.deepEqual(thinkingConfig("claude-sonnet-4-6", "off"), { includeThoughts: false, thinkingBudget: 0 });
  assert.equal(thinkingConfig("mystery-model", "high"), undefined, "an unknown family sends no budget");
});

test("autocomplete, image and enum-placeholder ids are not selectable", () => {
  for (const id of ["chat_20706", "tab_flash_lite", "gemini-3-pro-image", "MODEL_PLACEHOLDER_M26", "gemini flash", "imagen-4"]) {
    assert.equal(isSelectableRuntimeId(id), false, id);
  }
  for (const id of ["gemini-3.8-flash-low", "claude-sonnet-4-6", "gpt-oss-120b-medium"]) {
    assert.equal(isSelectableRuntimeId(id), true, id);
  }
});

test("the live catalogue groups runtime ids into public models by display level", () => {
  const catalog = buildCatalog({
    "gemini-4-flash-low": { displayName: "Gemini 4 Flash (Low)", supportsThinking: true, supportsImages: true },
    // The display name wins over a suffix that is one step off.
    "gemini-4-flash-extra-low": { displayName: "Gemini 4 Flash (Minimal)", supportsThinking: true },
    "gemini-4-flash-medium": { displayName: "Gemini 4 Flash (Medium)", supportsThinking: true },
    // Advertised but superseded: the agent id below serves High.
    "gemini-4-flash-high": { displayName: "Gemini 4 Flash (High)", supportsThinking: true },
    // A lone agent id is a level of the family sharing its display name, even
    // when that name carries the level itself.
    "gemini-4-flash-agent": { displayName: "Gemini 4 Flash (High)", supportsThinking: true },
    "gemini-4-pro-tiered": { displayName: "Gemini 4 Pro", supportsThinking: true },
    "gemini-4-flash-lite": { displayName: "Gemini 4 Flash Lite", supportsThinking: false, supportsImages: false },
    "claude-haiku-5": { displayName: "Claude Haiku 5", supportsThinking: true },
    "chat_12345": { displayName: "Chat" },
    "gemini-4-internal": { displayName: "Internal", isInternal: true },
  });

  const flash = catalog.find((model) => model.id === "gemini-4-flash")!;
  assert.equal(flash.name, "Gemini 4 Flash");
  assert.deepEqual(routes(flash), {
    minimal: "gemini-4-flash-extra-low",
    low: "gemini-4-flash-low",
    medium: "gemini-4-flash-medium",
    high: "gemini-4-flash-agent",
  });
  assert.ok(!catalog.some((model) => model.id === "gemini-4-flash-agent"), "the agent id must not be its own model");

  assert.deepEqual(routes(catalog.find((model) => model.id === "gemini-4-pro")!), { high: "gemini-4-pro-tiered" });

  const lite = catalog.find((model) => model.id === "gemini-4-flash-lite")!;
  assert.equal(lite.reasoning, false);
  assert.deepEqual(lite.input, ["text"]);
  assert.equal(runtimeModelId(lite), "gemini-4-flash-lite");

  assert.ok(catalog.some((model) => model.id === "claude-haiku-5"));
  assert.ok(!catalog.some((model) => /chat_|internal/.test(model.id)));
});

test("the static baseline always survives and wins over live entries with its id", () => {
  const catalog = buildCatalog({
    // A live entry for a known model must not replace its verified routing.
    "gemini-3.5-flash-low": { displayName: "Gemini 3.5 Flash (Low)" },
  });
  for (const model of STATIC_MODELS) {
    assert.deepEqual(catalog.find((candidate) => candidate.id === model.id), model, model.id);
  }
});

test("restoring a persisted catalogue re-applies the current static routing", () => {
  const stale = { ...byId("gemini-3.8-flash"), thinkingLevelMap: { high: "gemini-3.8-flash-renamed" } };
  const extra = { ...byId("gemini-3.8-flash"), id: "gemini-9-flash" };
  const foreign = { ...byId("gemini-3.8-flash"), id: "other", provider: "google" };
  const merged = withStaticModels([stale, extra, foreign] as Model<Api>[]);

  assert.deepEqual(merged.find((model) => model.id === "gemini-3.8-flash"), byId("gemini-3.8-flash"));
  assert.ok(merged.some((model) => model.id === "gemini-9-flash"));
  assert.ok(!merged.some((model) => model.id === "other"), "another provider's models are never adopted");
  // Newest Gemini Flash first, then Claude, then Pro, then GPT-OSS.
  assert.equal(merged[0].id, "gemini-9-flash");
  assert.equal(merged.at(-1)!.id, "gpt-oss-120b");
});

test("unknown model ids are humanised for the picker", () => {
  assert.equal(humanizeModelId("gpt-oss-240b"), "GPT-OSS 240B");
  assert.equal(humanizeModelId("gemini-4-0-flash"), "Gemini 4.0 Flash");
  assert.equal(humanizeModelId("claude-haiku-5"), "Claude Haiku 5");
});
