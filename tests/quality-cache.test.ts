import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The benchmark cache mirrors pi's remote model catalog: restore from disk,
 * only hit the network past the refresh interval, and revalidate with an ETag.
 * Each case gets an isolated PI_AGENT_DIR and a fresh module instance.
 */

const HOUR = 60 * 60 * 1000;

function record(slug: string) {
  return {
    slug,
    name: slug,
    creator: "test",
    evaluations: { artificial_analysis_coding_index: 50 },
    pricing: { blended3to1Per1M: 1 },
    performance: {},
  };
}

async function setup(store: unknown, fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-quality-"));
  if (store !== undefined) writeFileSync(join(dir, "model-quality.json"), JSON.stringify(store), "utf8");
  writeFileSync(join(dir, "pi-plus.env.json"), JSON.stringify({ ARTIFICIAL_ANALYSIS_API_KEY: "test-key" }), "utf8");
  process.env.PI_AGENT_DIR = dir;
  // env.ts caches per process; each case points at a new agent dir.
  (await import("../src/core/env.ts")).resetEnvCache();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const module = await import(`../src/core/catalog/quality.ts?case=${Math.random()}`);

  return {
    module,
    read: () => JSON.parse(readFileSync(join(dir, "model-quality.json"), "utf8")),
    cleanup: () => {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

test("refresh interval matches pi's 4 hours", async () => {
  const { module, cleanup } = await setup(undefined, async () => jsonResponse({ data: [] }));
  try {
    assert.equal(module.REFRESH_INTERVAL_MS, 4 * 60 * 60 * 1000);
  } finally {
    cleanup();
  }
});

test("a fresh cache skips the network entirely", async () => {
  let calls = 0;
  const { module, cleanup } = await setup(
    { records: { a: record("a") }, checkedAt: Date.now() - HOUR, source: "artificial-analysis" },
    async () => {
      calls += 1;
      return jsonResponse({ data: [] });
    },
  );
  try {
    assert.deepEqual(await module.refreshQuality(false), []);
    assert.equal(calls, 0, "inside the 4h window");
  } finally {
    cleanup();
  }
});

test("a stale cache revalidates and sends If-None-Match", async () => {
  let sent: string | undefined;
  const { module, read, cleanup } = await setup(
    { records: { a: record("a") }, checkedAt: Date.now() - 5 * HOUR, etag: 'W/"v1"', source: "artificial-analysis" },
    async (_url, init: any) => {
      sent = new Headers(init?.headers).get("if-none-match") ?? undefined;
      return new Response(null, { status: 304 });
    },
  );
  try {
    assert.deepEqual(await module.refreshQuality(false), []);
    assert.equal(sent, 'W/"v1"', "echoes the stored validator verbatim");
    const after = read();
    assert.deepEqual(Object.keys(after.records), ["a"], "304 must not empty the dataset");
    assert.equal(after.etag, 'W/"v1"', "validator survives a 304");
    assert.ok(after.checkedAt > Date.now() - 5000, "checkedAt is stamped");
  } finally {
    cleanup();
  }
});

test("no validator is sent when the cached dataset is empty", async () => {
  let sent: string | null = "unset";
  const { module, cleanup } = await setup(
    { records: {}, checkedAt: Date.now() - 5 * HOUR, etag: 'W/"v1"', source: "artificial-analysis" },
    async (_url, init: any) => {
      sent = new Headers(init?.headers).get("if-none-match");
      return jsonResponse({ data: [{ slug: "a", name: "a", evaluations: {}, pricing: {} }] });
    },
  );
  try {
    await module.refreshQuality(false);
    assert.equal(sent, null, "a 304 against an empty body would leave nothing to show");
  } finally {
    cleanup();
  }
});

test("a 200 stores records, etag and last-modified", async () => {
  const lastModified = "Wed, 21 Oct 2026 07:28:00 GMT";
  const { module, read, cleanup } = await setup(undefined, async () =>
    jsonResponse(
      { data: [{ slug: "glm-5", name: "GLM-5", evaluations: { gpqa: 0.5 }, pricing: { price_1m_blended_3_to_1: 2 } }] },
      { etag: 'W/"v2"', "last-modified": lastModified },
    ));
  try {
    assert.deepEqual(await module.refreshQuality(true), []);
    const after = read();
    assert.deepEqual(Object.keys(after.records), ["glm-5"]);
    assert.equal(after.etag, 'W/"v2"');
    assert.equal(after.lastModified, Date.parse(lastModified));
    assert.equal(typeof after.checkedAt, "number");
  } finally {
    cleanup();
  }
});

test("an HTTP error keeps the dataset but drops the validator", async () => {
  const { module, read, cleanup } = await setup(
    { records: { a: record("a") }, checkedAt: Date.now() - 5 * HOUR, etag: 'W/"v1"', source: "artificial-analysis" },
    async () => new Response("nope", { status: 500 }),
  );
  try {
    const warnings = await module.refreshQuality(false);
    assert.match(warnings[0], /HTTP 500/);
    const after = read();
    assert.deepEqual(Object.keys(after.records), ["a"], "old data stays usable");
    assert.equal(after.etag, undefined, "next attempt re-downloads instead of revalidating");
  } finally {
    cleanup();
  }
});

test("a network failure keeps the dataset and drops the validator", async () => {
  const { module, read, cleanup } = await setup(
    { records: { a: record("a") }, checkedAt: Date.now() - 5 * HOUR, etag: 'W/"v1"', source: "artificial-analysis" },
    async () => { throw new Error("socket hang up"); },
  );
  try {
    const warnings = await module.refreshQuality(false);
    assert.match(warnings[0], /socket hang up/);
    const after = read();
    assert.deepEqual(Object.keys(after.records), ["a"]);
    assert.equal(after.etag, undefined);
  } finally {
    cleanup();
  }
});

test("an empty upstream dataset never replaces good data", async () => {
  const { module, read, cleanup } = await setup(
    { records: { a: record("a") }, checkedAt: Date.now() - 5 * HOUR, source: "artificial-analysis" },
    async () => jsonResponse({ data: [] }),
  );
  try {
    const warnings = await module.refreshQuality(false);
    assert.match(warnings[0], /empty dataset/);
    assert.deepEqual(Object.keys(read().records), ["a"]);
  } finally {
    cleanup();
  }
});

test("the legacy fetchedAt format migrates to checkedAt", async () => {
  const { module, cleanup } = await setup(
    { records: { a: record("a") }, fetchedAt: Date.now() - HOUR, source: "artificial-analysis" },
    async () => { throw new Error("should not be called"); },
  );
  try {
    const status = module.qualityStatus();
    assert.equal(status.records, 1);
    assert.ok(status.checkedAt, "fetchedAt was adopted as checkedAt");
    assert.ok(module.qualityAgeMs() < 2 * HOUR, "so the entry still counts as fresh");
  } finally {
    cleanup();
  }
});

test("missing API key reports rather than throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-quality-"));
  process.env.PI_AGENT_DIR = dir;
  const previous = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  (await import("../src/core/env.ts")).resetEnvCache();
  try {
    const module = await import(`../src/core/catalog/quality.ts?case=${Math.random()}`);
    const warnings = await module.refreshQuality(true);
    assert.match(warnings[0], /no API key/);
  } finally {
    if (previous !== undefined) process.env.ARTIFICIAL_ANALYSIS_API_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
