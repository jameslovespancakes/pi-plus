import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { saveCodexAccounts } from "../src/core/codex/store.ts";
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
