import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { registerPooledOAuthProvider } from "../src/providers/shared/serving.ts";
import { quotaStateFromHeaders } from "../src/providers/shared/accounts/routing.ts";
import { message, model, response } from "./fixtures/provider-stream.ts";

const account = (id: string, overrides = {}) => ({ type: "oauth", id, label: id, access: id, refresh: `${id}-refresh`, expires: Date.now() + 3_600_000, addedAt: 1, ...overrides });
function pool(t: any, config: any = {}) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const waits: number[] = [], sent: any[] = [], observed: any[] = [];
  const storage = { mode: "sequential", accounts: config.accounts ?? [account("secondary")] };
  let primaryQuota = config.primaryQuota;
  let registered: any;
  const primary = account("primary");
  const stream = async (selected: any, context: any, options: any) => {
    sent.push({ model: selected, context, options, at: now });
    return config.stream ? await config.stream(options, sent.length) : response(message());
  };
  const base: any = { id: `fixture-${randomUUID()}`, name: "Fixture", compat: { supportsMidConvoSystemMessages: true },
    auth: { oauth: {
      toAuth: async (credential: any) => ({ apiKey: credential.access, headers: { Authorization: `Bearer ${credential.access}`, "x-account": credential.access } }),
      refresh: config.refresh ?? (async (credential: any) => credential),
    } }, stream, streamSimple: stream,
  };
  registerPooledOAuthProvider({ registerProvider: (provider: any) => { registered = provider; } } as any, {
    id: base.id, label: "Fixture", createProvider: () => base,
    identityOfCredential: config.identityOfCredential,
    checkQuota: config.checkQuota,
    store: { load: () => storage, saveMode() {}, primaryQuota: () => primaryQuota,
      saveAccount: (value: any) => { storage.accounts = storage.accounts.map((entry: any) => entry.id === value.id ? value : entry); },
    },
    recordQuota(id: string, status: number, headers: any, credential: any, modelId: string) {
      observed.push({ id, status, credential: credential.access, modelId });
      if (id === "main") primaryQuota = quotaStateFromHeaders(status, headers, primaryQuota);
      else {
        const entry = storage.accounts.find((candidate: any) => candidate.id === id);
        if (entry) entry.quota = quotaStateFromHeaders(status, headers, entry.quota);
      }
    },
  }, { sleep: async (delay) => { waits.push(delay); now += delay; } });
  const auth = () => registered.auth.oauth.toAuth(primary);
  return { provider: registered, base, primary, storage, waits, sent, observed, auth };
}

test("both native stream surfaces rotate accounts with the same model, tools, transport, and hooks", async (t) => {
  for (const surface of ["stream", "streamSimple"]) {
    const h = pool(t, { stream: async (options: any) => {
      const status = options.apiKey === "primary" ? 429 : 200;
      await options.onResponse({ status, headers: { "retry-after": "10" } }, model);
      return response(message(status === 429 ? "Request rejected" : undefined));
    } });
    const auth = await h.auth();
    const context = { messages: [{ role: "user", content: "Task" }], tools: [{ name: "change" }] };
    const transport = () => { throw new Error("not called by fixture"); };
    const payload = (value: unknown) => value;
    let responses = 0;
    const result = await h.provider[surface](model, context, { ...auth,
      headers: { authorization: "Bearer primary", "X-Account": "primary", "x-caller": "keep" },
      fetch: transport, onPayload: payload, maxRetries: 8, onResponse: () => { responses++; },
    }).result();
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(h.sent.map((call) => call.options.apiKey), ["primary", "secondary"]);
    assert.deepEqual(h.waits, []);
    assert.equal(responses, 2);
    assert.equal(h.provider.compat, h.base.compat);
    for (const call of h.sent) {
      assert.equal(call.model, model);
      assert.equal(call.context, context);
      assert.equal(call.options.fetch, transport);
      assert.equal(call.options.onPayload, payload);
      assert.equal(call.options.maxRetries, 0);
      assert.equal(call.options.headers.Authorization, `Bearer ${call.options.apiKey}`);
      assert.equal(call.options.headers["x-account"], call.options.apiKey);
      assert.equal(call.options.headers.authorization, undefined);
      assert.equal(call.options.headers["X-Account"], undefined);
      assert.equal(call.options.headers["x-caller"], "keep");
    }
  }
});

test("all eligible accounts are retried in exactly three timed rounds, honoring a short Retry-After", async (t) => {
  const h = pool(t, { stream: async (options: any) => {
    await options.onResponse({ status: 429, headers: { "Retry-After": "10" } }, model);
    return response(message("Request rejected")); // status, not error wording, identifies the limit
  } });
  const result = await h.provider.streamSimple(model, {}, await h.auth()).result();
  assert.equal(result.stopReason, "error");
  assert.deepEqual(h.waits, [10_000, 25_000, 60_000]);
  assert.deepEqual(h.sent.map((call) => call.options.apiKey), ["primary", "secondary", "primary", "secondary", "primary", "secondary", "primary", "secondary"]);
  assert.deepEqual(h.sent.map((call) => call.at - h.sent[0].at), [0, 0, 10000, 10000, 35000, 35000, 95000, 95000]);
  assert.equal(result.diagnostics.at(-1).details.attempts, 8);
  assert.match(result.errorMessage, /Account usage limit/);
});

test("headerless 429 cooldowns expire, while longer server reset hints are never bypassed", async (t) => {
  for (const longReset of [false, true]) {
    const h = pool(t, { stream: async (options: any) => {
      if (longReset) await options.onResponse({ status: 429, headers: { "retry-after": new Date(Date.now() + 3_600_000).toUTCString() } }, model);
      return response(message("429"));
    } });
    const result = await h.provider.stream(model, {}, await h.auth()).result();
    assert.deepEqual(h.waits, [10000, 25000, 60000]);
    assert.equal(h.sent.length, longReset ? 2 : 8);
    assert.equal(result.stopReason, "error");
    if (!longReset) assert.equal(h.sent[2].at - h.sent[0].at, 10000, "a missing reset hint must not suppress the first fallback round");
  }
});

test("disabled, duplicate, and exhausted credentials cannot create phantom fallback capacity", async (t) => {
  const h = pool(t, {
    accounts: [account("duplicate-main", { access: "primary" }), account("disabled", { enabled: false }),
      account("secondary"), account("duplicate-secondary", { access: "secondary" }), account("empty", { quota: { remainingPercent: 0, checkedAt: Date.now() } })],
    stream: () => response(message("503 unavailable")),
  });
  await h.provider.stream(model, {}, await h.auth()).result();
  assert.equal(h.sent.length, 8);
  assert.deepEqual([...new Set(h.sent.map((call) => call.options.apiKey))], ["primary", "secondary"]);
});

test("limit failures check actual serving credentials, honor usage-endpoint cooldowns, and tolerate status outages", async (t) => {
  const checked: any[] = [];
  const h = pool(t, {
    checkQuota: async (id: string, credential: any, modelId: string, signal: AbortSignal) => {
      checked.push({ id, access: credential.access, modelId, signal });
      return Date.now() + 600_000; // A status endpoint's Retry-After, not an inference allowance.
    },
    stream: async () => response(message("429")),
  });
  await h.provider.streamSimple(model, {}, await h.auth()).result();
  assert.equal(h.sent.length, 8, "a throttled status endpoint must not invent an exhausted inference quota");
  assert.deepEqual(checked.map(({ id, access, modelId }) => ({ id, access, modelId })), [
    { id: "main", access: "primary", modelId: model.id }, { id: "secondary", access: "secondary", modelId: model.id },
  ]);
  assert.ok(checked.every((entry) => entry.signal instanceof AbortSignal));
  const outage = pool(t, { checkQuota: async () => { throw new Error("status offline"); },
    stream: async (options: any) => response(message(options.apiKey === "primary" ? "429" : undefined)) });
  assert.equal((await outage.provider.streamSimple(model, {}, await outage.auth()).result()).stopReason, "stop");
  assert.deepEqual(outage.sent.map((entry) => entry.options.apiKey), ["primary", "secondary"]);
});

test("concurrent failures share a usage check and non-limit failures never poll usage", async (t) => {
  let checks = 0;
  const h = pool(t, { checkQuota: async () => { checks++; await new Promise((resolve) => setImmediate(resolve)); },
    stream: async (options: any) => response(message(options.apiKey === "primary" ? "429" : undefined)) });
  const auth = await h.auth();
  const results = await Promise.all([h.provider.streamSimple(model, {}, auth).result(), h.provider.stream(model, {}, auth).result()]);
  assert.ok(results.every((entry) => entry.stopReason === "stop"));
  assert.equal(checks, 1);
  const transient = pool(t, { checkQuota: async () => { checks++; },
    stream: async (options: any) => response(message(options.apiKey === "primary" ? "503 Service Unavailable" : undefined)) });
  assert.equal((await transient.provider.streamSimple(model, {}, await transient.auth()).result()).stopReason, "stop");
  assert.equal(checks, 1);
});

test("cancellation does not wait for an uncooperative usage check or send a late fallback", async (t) => {
  let checking!: () => void;
  const started = new Promise<void>((resolve) => { checking = resolve; });
  let release!: () => void;
  const h = pool(t, { checkQuota: () => { checking(); return new Promise<void>((resolve) => { release = resolve; }); },
    stream: async () => response(message("429")) });
  const controller = new AbortController();
  const result = h.provider.streamSimple(model, {}, { ...await h.auth(), signal: controller.signal }).result();
  await started;
  controller.abort();
  assert.equal((await result).stopReason, "aborted");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
});

test("an entirely exhausted pool rechecks eligibility without sending any requests", async (t) => {
  const exhausted = { remainingPercent: 0, checkedAt: Date.now() };
  const h = pool(t, { primaryQuota: exhausted, accounts: [account("secondary", { quota: exhausted })] });
  const result = await h.provider.stream(model, {}, await h.auth()).result();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.waits, [10000, 25000, 60000]);
  assert.equal(result.stopReason, "error");
});

test("refresh failures fail over without replaying the agent or retrying a known-bad credential immediately", async (t) => {
  let refreshes = 0;
  const h = pool(t, { primaryQuota: { remainingPercent: 0, checkedAt: Date.now() },
    accounts: [account("expired", { expires: 0 }), account("healthy")],
    refresh: async () => { refreshes++; throw new Error("401 invalid_grant"); },
  });
  const result = await h.provider.stream(model, {}, await h.auth()).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(refreshes, 1);
  assert.deepEqual(h.sent.map((call) => call.options.apiKey), ["healthy"]);
  assert.deepEqual(h.waits, []);
});

test("concurrent requests share one refresh; cancelling a waiter does not cancel another", async (t) => {
  let finish!: (credential: any) => void, ready!: () => void;
  let refreshes = 0;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const h = pool(t, { primaryQuota: { remainingPercent: 0, checkedAt: Date.now() }, accounts: [account("expired", { expires: 0 })],
    refresh: () => { refreshes++; ready(); return new Promise((resolve) => { finish = resolve; }); },
  });
  const auth = await h.auth();
  const controller = new AbortController();
  const first = h.provider.stream(model, {}, { ...auth, signal: controller.signal }).result();
  const second = h.provider.streamSimple(model, {}, auth).result();
  await started;
  controller.abort();
  assert.equal((await first).stopReason, "aborted");
  finish({ type: "oauth", access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 });
  assert.equal((await second).stopReason, "stop");
  assert.equal(refreshes, 1);
  assert.equal(h.storage.accounts[0].access, "rotated");
  assert.deepEqual(h.sent.map((call) => call.options.apiKey), ["rotated"]);
});

test("API-key requests bypass subscription routing without changing caller options", async (t) => {
  const h = pool(t);
  const options = { apiKey: "ordinary-api-key", maxRetries: 3 };
  await (await h.provider.stream(model, {}, options)).result();
  assert.equal(h.sent[0].options, options);
  assert.equal(h.observed.length, 0);
  assert.deepEqual(h.waits, []);
});

test("real pooled request failover keeps completed native Agent tools single-execution", async (t) => {
  let toolRuns = 0;
  const h = pool(t, { stream: async (options: any, call: number) => {
    if (call === 1) return response(message(undefined, { stopReason: "toolUse", content: [{ type: "toolCall", id: "one-change", name: "change", arguments: {} }] }));
    const failed = options.apiKey === "primary";
    await options.onResponse({ status: failed ? 429 : 200, headers: {} }, model);
    return response(message(failed ? "429" : undefined));
  } });
  const auth = await h.auth();
  const agent = new Agent({ initialState: { model, tools: [{ name: "change", label: "Change", description: "Fixture", parameters: Type.Object({}),
    execute: async () => { toolRuns++; return { content: [{ type: "text", text: "changed" }], details: {} }; },
  }] }, streamFn: (selected, context, options) => h.provider.streamSimple(selected, context, { ...auth, ...options }) });
  await agent.prompt("Change once.");
  assert.equal(toolRuns, 1);
  assert.deepEqual(h.sent.map((call) => call.options.apiKey), ["primary", "primary", "secondary"]);
  assert.equal(h.sent[1].context, h.sent[2].context);
  assert.ok(h.sent[2].context.messages.some((entry: any) => entry.role === "toolResult"));
  assert.deepEqual(h.waits, []);
});
