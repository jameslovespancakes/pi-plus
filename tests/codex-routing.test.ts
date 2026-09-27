import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { applyCodexQuotaHeaders } from "../src/providers/codex/quota.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../src/providers/codex/store.ts";
import { OAUTH_REFRESH_TIMEOUT_MS, refreshAbortSignal } from "../src/providers/shared/accounts/routing.ts";
import {
  chooseCodexCredential,
  codexRoutingMode,
  CODEX_SPEC,
} from "../src/providers/codex/provider.ts";

import { chooseCredential, registerPooledOAuthProvider } from "../src/providers/shared/serving.ts";
import { model, message, response } from "./fixtures/provider-stream.ts";

function providerFixture(respond = (_model: any, _options: any) => response(message())) {
  let provider: any;
  const sent: any[] = [];
  const base = CODEX_SPEC.createProvider();
  const stream = (selected: any, _context: any, options: any) => { sent.push(options); return respond(selected, options); };
  registerPooledOAuthProvider({ registerProvider: (value: any) => { provider = value; } } as any, {
    ...CODEX_SPEC, createProvider: () => ({ ...base, stream, streamSimple: stream }),
  }, { sleep: async () => { assert.fail("healthy account must not wait"); } });
  return { provider, sent };
}

const primary: OAuthCredential = {
  type: "oauth",
  access: "primary-access",
  refresh: "primary-refresh",
  expires: Date.now() + 3_600_000,
};

function quota(remainingPercent: number) {
  return {
    five_hour: { remainingPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    seven_day: { remainingPercent },
    checkedAt: Date.now(),
    source: "headers" as const,
  };
}

async function withCodexStore(run: (path: string) => void | Promise<void>): Promise<void> {
  const path = join(tmpdir(), `pi-plus-codex-routing-${randomUUID()}.json`);
  process.env.PI_PLUS_CODEX_ACCOUNTS_FILE = path;
  try {
    await run(path);
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_CODEX_ACCOUNTS_FILE;
  }
}

test("legacy Codex routing modes migrate to the two public modes", () => {
  assert.equal(codexRoutingMode("standard"), "sequential");
  assert.equal(codexRoutingMode("optimal"), "quota-aware");
});

test("Codex sequential routing moves to account two when account one is exhausted", async () => {
  await withCodexStore((path) => {
    saveCodexAccounts({
      main: { quota: quota(0) },
      routing: { mode: "sequential" },
      accounts: [{
        id: "two",
        access: "second-access",
        refresh: "second-refresh",
        expires: Date.now() + 3_600_000,
        quota: quota(70),
      }],
    }, path);
    assert.equal(chooseCodexCredential(primary).id, "two");
  });
});

test("Codex quota-aware routing selects the credential actually sent by the stream", async () => {
  await withCodexStore(async (path) => {
    saveCodexAccounts({
      main: { quota: quota(20) },
      routing: { mode: "quota-aware" },
      accounts: [{
        id: "most",
        access: "most-access",
        refresh: "most-refresh",
        expires: Date.now() + 3_600_000,
        quota: quota(85),
      }],
    }, path);

    const { provider, sent } = providerFixture();
    const auth = await provider.auth.oauth.toAuth(primary);
    assert.equal(auth.apiKey, "primary-access");
    await provider.streamSimple(model, { messages: [] }, auth).result();
    assert.equal(sent[0].apiKey, "most-access");
  });
});

test("routing a request preserves the rich Codex quota snapshot", async () => {
  // Codex joins the shared pooled serving path, whose accounts carry a
  // flattened routing quota. Writing that back over the stored snapshot would
  // destroy the window detail the usage bars render.
  await withCodexStore(async (path) => {
    saveCodexAccounts({
      routing: { mode: "quota-aware" },
      // main must be measured, otherwise quota-aware probes the unmeasured
      // primary first and no pooled account is selected.
      main: { quota: quota(20) },
      accounts: [{
        id: "pooled",
        label: "Work",
        access: "pooled-access",
        refresh: "pooled-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct-1",
        plan: "pro",
        quota: quota(64),
      }],
    }, path);

    const { provider, sent } = providerFixture();
    // The actual stream drives the pooled lastUsed write, not auth resolution.
    const auth = await provider.auth.oauth.toAuth(primary);
    await provider.stream(model, { messages: [] }, auth).result();
    assert.equal(sent[0].apiKey, "pooled-access", "the pooled account served the request");

    const stored = loadCodexAccounts(path).accounts[0]!;
    assert.equal(stored.quota?.five_hour?.remainingPercent, 64, "window detail survives");
    assert.equal(stored.accountId, "acct-1", "ChatGPT account id survives");
    assert.equal(stored.plan, "pro", "plan survives");
    assert.ok(stored.lastUsed, "routing still records usage");
  });
});

test("an exhausted account with no reset never persists an Infinity block", async () => {
  // Number.POSITIVE_INFINITY serializes to null, which reads back as "not
  // blocked" and silently un-exhausts the account on the next load.
  await withCodexStore(async (path) => {
    saveCodexAccounts({
      routing: { mode: "sequential" },
      main: { quota: { five_hour: { remainingPercent: 0 }, checkedAt: Date.now(), source: "headers" } as any },
      accounts: [{
        id: "two",
        access: "second-access",
        refresh: "second-refresh",
        expires: Date.now() + 3_600_000,
        quota: quota(70),
      }],
    }, path);

    assert.equal(chooseCodexCredential(primary).id, "two", "exhausted main is skipped");
    assert.ok(!readFileSync(path, "utf8").includes("null"), "no Infinity round-tripped to null");
  });
});

test("headerless Codex limits check the serving account and persist exhaustion beyond the retry cooldown", async (t) => {
  await withCodexStore(async (path) => {
    saveCodexAccounts({ main: { quota: quota(0) }, accounts: [
      { id: "limited", access: "limited-access", refresh: "r1", expires: primary.expires, accountId: "chat-limited" },
      { id: "healthy", access: "healthy-access", refresh: "r2", expires: primary.expires, accountId: "chat-healthy" },
    ] }, path);
    const lookups: any[] = [];
    t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
      lookups.push({ url: String(url), headers: new Headers(init.headers) });
      return Response.json({ plan_type: "pro", rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: (Date.now() + 3_600_000) / 1000 },
        secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: (Date.now() + 86_400_000) / 1000 },
      } });
    });
    const { provider, sent } = providerFixture((_model, options) => response(message(options.apiKey === "limited-access" ? "429" : undefined)));
    const auth = await provider.auth.oauth.toAuth(primary);
    assert.equal((await provider.streamSimple(model, {}, auth).result()).stopReason, "stop");
    assert.deepEqual(sent.map((entry) => entry.apiKey), ["limited-access", "healthy-access"]);
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(lookups[0].headers.get("authorization"), "Bearer limited-access");
    assert.equal(lookups[0].headers.get("chatgpt-account-id"), "chat-limited");
    const limited = loadCodexAccounts().accounts.find((entry) => entry.id === "limited")!;
    assert.equal(limited.quota?.seven_day?.remainingPercent, 0);
    assert.equal(limited.refresh, "r1");
    const later = Date.now() + 20_000;
    t.mock.method(Date, "now", () => later);
    assert.equal((await provider.streamSimple(model, {}, auth).result()).stopReason, "stop");
    assert.equal(sent.at(-1).apiKey, "healthy-access");
    assert.equal(lookups.length, 1);
  });
});

test("Codex model-specific exhaustion does not block unrelated models", async () => {
  await withCodexStore((path) => {
    saveCodexAccounts({ main: { quota: { ...quota(80), scoped: [
      { id: "GPT-5.3-Codex-Spark", remainingPercent: 0, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    ] } }, accounts: [{ id: "healthy", access: "healthy", refresh: "r", expires: primary.expires }] }, path);
    assert.equal(chooseCredential(CODEX_SPEC, primary, { modelId: "gpt-5.3-codex-spark" })?.id, "healthy");
    assert.equal(chooseCredential(CODEX_SPEC, primary, { modelId: "gpt-5.4" })?.id, "main");
    applyCodexQuotaHeaders("main", { "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "300" });
    assert.equal(loadCodexAccounts().main?.quota?.seven_day?.remainingPercent, 80, "partial headers retain other windows");
    assert.equal(chooseCredential(CODEX_SPEC, primary, { modelId: "gpt-5.3-codex-spark" })?.id, "healthy", "base-model headers do not erase scoped exhaustion");
  });
});

test("a routed token refresh is bounded like pi-ai's own refresh", () => {
  // Routed auth runs outside pi-ai's refresh path, so nothing else bounds it;
  // an unbounded refresh is shared by every later request for that account.
  assert.equal(OAUTH_REFRESH_TIMEOUT_MS, 15_000, "matches DEFAULT_OAUTH_REFRESH_TIMEOUT_MS");

  const caller = new AbortController();
  const signal = refreshAbortSignal(caller.signal);
  assert.equal(signal.aborted, false);
  caller.abort();
  assert.equal(signal.aborted, true, "a caller abort must still cancel the refresh");
});
