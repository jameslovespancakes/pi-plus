import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedAnthropicModels,
  catalogIsStale,
  CATALOG_TTL_MS,
  fetchAnthropicModels,
  refreshAnthropicCatalog,
  writeAnthropicCatalog,
} from "../src/core/anthropic/catalog.ts";
import { buildAnthropicModels } from "../src/core/anthropic/models.ts";

/**
 * pi's bundled catalogue is generated at build time, so a model Anthropic
 * ships afterwards is invisible until pi is upgraded. `claude-opus-5-5` was
 * usable for days while the picker insisted it did not exist.
 */

async function withCache(run: () => void | Promise<void>): Promise<void> {
  const path = join(tmpdir(), `pi-plus-anthropic-models-${randomUUID()}.json`);
  process.env.PI_PLUS_ANTHROPIC_MODELS_FILE = path;
  try {
    await run();
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_ANTHROPIC_MODELS_FILE;
  }
}

function stubFetch(handler: (url: string, init: any) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const LIST = new Response(JSON.stringify({
  data: [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { id: "claude-opus-5", display_name: "Claude Opus 5" },
  ],
}), { status: 200 });

test("an OAuth subscription token is sent as a bearer, not an x-api-key", async () => {
  const stub = stubFetch(() => LIST.clone());
  try {
    // An Anthropic OAuth token is `sk-ant-oat…` and an API key is `sk-ant-api…`,
    // so a bare `sk-` prefix test routes subscriptions into a 401.
    await fetchAnthropicModels({ apiKey: "sk-ant-oat01-abc", source: "OAuth" });
    assert.equal(stub.calls[0].headers.Authorization, "Bearer sk-ant-oat01-abc");
    assert.equal(stub.calls[0].headers["x-api-key"], undefined);

    await fetchAnthropicModels({ apiKey: "sk-ant-oat01-abc" });
    assert.equal(stub.calls[1].headers.Authorization, "Bearer sk-ant-oat01-abc");

    await fetchAnthropicModels({ apiKey: "sk-ant-api03-xyz" });
    assert.equal(stub.calls[2].headers["x-api-key"], "sk-ant-api03-xyz");
    assert.equal(stub.calls[2].headers.Authorization, undefined);
  } finally {
    stub.restore();
  }
});

test("the model list is asked for with exactly the oauth beta", async () => {
  const stub = stubFetch(() => LIST.clone());
  try {
    await fetchAnthropicModels({
      apiKey: "sk-ant-oat01-abc",
      source: "OAuth",
      // Carrying the /v1/messages betas over to /v1/models is rejected.
      headers: { "anthropic-beta": "claude-code-20250219,fine-grained-tool-streaming-2025-05-14" },
    });
    assert.equal(stub.calls[0].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.match(stub.calls[0].url, /\/v1\/models\?limit=\d+$/);
  } finally {
    stub.restore();
  }
});

test("refresh caches the list and reports only what is new", async () => {
  await withCache(async () => {
    const stub = stubFetch(() => LIST.clone());
    try {
      assert.deepEqual(
        await refreshAnthropicCatalog({ apiKey: "sk-ant-oat01-a", source: "OAuth" }),
        ["claude-opus-5-5", "claude-opus-5"],
      );
      assert.equal(cachedAnthropicModels().length, 2);
      // Nothing new the second time, so the provider is not re-registered.
      assert.deepEqual(await refreshAnthropicCatalog({ apiKey: "sk-ant-oat01-a", source: "OAuth" }), []);
    } finally {
      stub.restore();
    }
  });
});

test("an empty or failed response never clears a good cache", async () => {
  await withCache(async () => {
    writeAnthropicCatalog([{ id: "claude-opus-5-5", displayName: "Claude Opus 5.5" }]);

    const empty = stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    try {
      assert.deepEqual(await refreshAnthropicCatalog({ apiKey: "sk-ant-api03-x" }), []);
      assert.equal(cachedAnthropicModels().length, 1);
    } finally {
      empty.restore();
    }

    const failing = stubFetch(() => new Response("nope", { status: 500 }));
    try {
      await assert.rejects(() => refreshAnthropicCatalog({ apiKey: "sk-ant-api03-x" }), /500/);
      assert.equal(cachedAnthropicModels().length, 1);
    } finally {
      failing.restore();
    }
  });
});

test("staleness is time based so startup costs at most one call a day", async () => {
  await withCache(async () => {
    assert.equal(catalogIsStale(), true, "an empty cache is stale");
    writeAnthropicCatalog([{ id: "claude-opus-5" }]);
    assert.equal(catalogIsStale(), false);
    assert.equal(catalogIsStale(Date.now() + CATALOG_TTL_MS + 1_000), true);
  });
});

test("a discovered model inherits from the newest of its family", () => {
  const merged = buildAnthropicModels([
    { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
    { id: "claude-sonnet-9-9", displayName: "Claude Sonnet 9.9" },
  ]);

  const opus55 = merged.find((model) => model.id === "claude-opus-5-5")!;
  const opus5 = merged.find((model) => model.id === "claude-opus-5")!;
  assert.ok(opus55, "claude-opus-5-5 must be offered");
  assert.equal(opus55.name, "Claude Opus 5.5");
  // Inheriting beats guessing: limits and pricing track pi's newest Opus.
  assert.equal(opus55.contextWindow, opus5.contextWindow);
  assert.equal(opus55.maxTokens, opus5.maxTokens);
  assert.deepEqual(opus55.cost, opus5.cost);

  const sonnet = merged.find((model) => model.id === "claude-sonnet-9-9")!;
  assert.equal(sonnet.cost.input, merged.find((m) => m.id === "claude-sonnet-5")!.cost.input);
});

test("discovery never drops or duplicates an existing model", () => {
  const withLive = buildAnthropicModels([
    { id: "claude-opus-5-5" },
    { id: "claude-opus-5" },
    { id: "claude-wholly-unknown-1" },
  ]);
  const withoutLive = buildAnthropicModels([]);

  for (const model of withoutLive) {
    assert.ok(withLive.some((candidate) => candidate.id === model.id), `${model.id} dropped`);
  }
  assert.equal(new Set(withLive.map((m) => m.id)).size, withLive.length, "duplicate ids");
  // An unrecognised family has no template, so nothing can be inferred for it.
  assert.ok(!withLive.some((model) => model.id === "claude-wholly-unknown-1"));
});
