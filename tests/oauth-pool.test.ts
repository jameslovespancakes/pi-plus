import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOAuthPool,
  oauthIdentity,
  resetOAuthPoolCache,
  saveOAuthAccount,
  setOAuthPoolMode,
} from "../src/core/accounts/oauth-pool.ts";
import { createPooledOAuthAdapter } from "../src/domains/subscriptions/providers/oauth-pool.ts";

function tempStore(): string {
  return join(tmpdir(), `pi-plus-oauth-${randomUUID()}.json`);
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("OAuth pools keep providers separate", () => {
  const path = tempStore();
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = path;
  resetOAuthPoolCache();

  saveOAuthAccount("xai", {
    type: "oauth", id: "x1", label: "Work", access: "x-access", refresh: "x-refresh", expires: 10,
    addedAt: 1,
  });
  saveOAuthAccount("kimi-coding", {
    type: "oauth", id: "k1", label: "Personal", access: "k-access", refresh: "k-refresh", expires: 20,
    addedAt: 2,
  });

  assert.deepEqual(loadOAuthPool("xai").accounts.map((account) => account.id), ["x1"]);
  assert.deepEqual(loadOAuthPool("kimi-coding").accounts.map((account) => account.id), ["k1"]);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.xai.accounts[0].refresh, "x-refresh");

  rmSync(path, { force: true });
  delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
  resetOAuthPoolCache();
});

test("OAuth routing mode persists", () => {
  const path = tempStore();
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = path;
  resetOAuthPoolCache();

  assert.equal(loadOAuthPool("xai").mode, "standard");
  setOAuthPoolMode("xai", "optimal");
  resetOAuthPoolCache();
  assert.equal(loadOAuthPool("xai").mode, "optimal");

  rmSync(path, { force: true });
  delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
  resetOAuthPoolCache();
});

test("OAuth identity uses stable JWT claims", () => {
  assert.equal(oauthIdentity(jwt({ sub: "user-1", email: "other@example.com" })), "sub:user-1");
  assert.equal(oauthIdentity(jwt({ email: "user@example.com" })), "email:user@example.com");
  assert.equal(oauthIdentity("opaque-token"), undefined);
});

test("OAuth account adapters rename, toggle, and route", async () => {
  const path = tempStore();
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = path;
  resetOAuthPoolCache();
  try {
    saveOAuthAccount("xai", {
      type: "oauth", id: "x1", label: "Work", access: "access", refresh: "refresh", expires: Date.now() + 60_000, addedAt: 1,
    });
    const adapter = createPooledOAuthAdapter({ id: "xai", label: "Grok", createProvider: () => ({}) as any });

    assert.deepEqual(await adapter.list(), [{ id: "x1", label: "Work", enabled: true, expiresAt: loadOAuthPool("xai").accounts[0].expires }]);
    await adapter.rename!("x1", "Personal");
    await adapter.setEnabled!("x1", false);
    assert.deepEqual(await adapter.list(), [{ id: "x1", label: "Personal", enabled: false, expiresAt: loadOAuthPool("xai").accounts[0].expires }]);
    assert.equal(await adapter.routing!.set("optimal"), "optimal");
    assert.equal(await adapter.routing!.get(), "optimal");
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
    resetOAuthPoolCache();
  }
});
