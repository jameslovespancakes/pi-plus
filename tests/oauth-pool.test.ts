import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOAuthPool,
  oauthIdentity,
  resetOAuthPoolCache,
  saveOAuthAccount,
  setOAuthPoolMode,
} from "../src/core/accounts/oauth-pool.ts";
import { createPooledOAuthAdapter, registerPooledOAuthProvider } from "../src/domains/subscriptions/providers/oauth-pool.ts";

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

  assert.equal(loadOAuthPool("xai").mode, "sequential");
  setOAuthPoolMode("xai", "quota-aware");
  resetOAuthPoolCache();
  assert.equal(loadOAuthPool("xai").mode, "quota-aware");

  rmSync(path, { force: true });
  delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
  resetOAuthPoolCache();
});

test("hosted sequential routing moves to account two after a rate limit", async () => {
  const path = tempStore();
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = path;
  resetOAuthPoolCache();
  try {
    saveOAuthAccount("test-hosted", {
      type: "oauth", id: "two", label: "Two", access: "second", refresh: "refresh", expires: Date.now() + 60_000, addedAt: 1,
    });
    let registered: any;
    const oauth = {
      name: "Test",
      login: async () => { throw new Error("unused"); },
      refresh: async (credential: any) => credential,
      toAuth: async (credential: any) => ({ headers: { Authorization: `Bearer ${credential.access}` } }),
    };
    registerPooledOAuthProvider({ registerProvider: (provider: any) => { registered = provider; } } as any, {
      id: "test-hosted",
      label: "Test",
      createProvider: () => ({
        id: "test-hosted",
        name: "Test",
        auth: { oauth },
        getModels: () => [],
        stream: (_model: any, _context: any, options: any) => {
          void options.onResponse({ status: 429, headers: { "retry-after": "60" } }, {});
          return {};
        },
        streamSimple: () => ({}),
      }) as any,
    });
    const primary = { type: "oauth", access: "primary", refresh: "refresh", expires: Date.now() + 60_000 };
    const first = await registered.auth.oauth.toAuth(primary);
    assert.equal(first.headers.Authorization, "Bearer primary");
    registered.stream({}, {}, first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await registered.auth.oauth.toAuth(primary);
    assert.equal(second.headers.Authorization, "Bearer second");
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
    resetOAuthPoolCache();
  }
});

test("legacy hosted routing modes migrate to the two public modes", () => {
  const path = tempStore();
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = path;
  writeFileSync(path, JSON.stringify({ providers: { xai: { mode: "optimal", accounts: [] } } }));
  resetOAuthPoolCache();
  try {
    assert.equal(loadOAuthPool("xai").mode, "quota-aware");
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
    resetOAuthPoolCache();
  }
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
    assert.equal(await adapter.routing!.set("quota-aware"), "quota-aware");
    assert.equal(await adapter.routing!.get(), "quota-aware");
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
    resetOAuthPoolCache();
  }
});
