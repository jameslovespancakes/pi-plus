import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { loadCodexAccounts, saveCodexAccounts } from "../src/core/codex/store.ts";
import { OAUTH_REFRESH_TIMEOUT_MS, refreshAbortSignal } from "../src/core/accounts/routing.ts";
import {
  chooseCodexCredential,
  codexRoutingMode,
  registerCodexProvider,
} from "../src/domains/subscriptions/providers/codex.ts";

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

test("Codex quota-aware routing is wired into provider request auth", async () => {
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

    let provider: any;
    registerCodexProvider({ registerProvider: (value: any) => { provider = value; } } as any);
    const auth = await provider.auth.oauth.toAuth(primary);
    assert.equal(auth.apiKey, "most-access");
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

    let provider: any;
    registerCodexProvider({ registerProvider: (value: any) => { provider = value; } } as any);
    // Drives the pooled `lastUsed` write, which is where the clobber happened.
    const auth = await provider.auth.oauth.toAuth(primary);
    assert.equal(auth.apiKey, "pooled-access", "the pooled account served the request");

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
