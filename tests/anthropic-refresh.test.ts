import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCESS_REFRESH_WINDOW_MS,
  accessTokenNeedsRefresh,
  ensureAccessToken,
  refreshDueAccessTokens,
} from "../src/core/anthropic/quota.ts";
import { anthropicAccountIdentity } from "../src/core/anthropic/identity.ts";
import { observeClaudeQuota } from "../src/core/anthropic/usage-cache.ts";
import { loadAccounts, saveAccounts, type Account } from "../src/core/anthropic/store.ts";
import { routeAccessToken } from "../src/domains/subscriptions/provider.ts";

function fixture(account: Account) {
  const directory = mkdtempSync(join(tmpdir(), "pi-plus-anthropic-refresh-"));
  const config = join(directory, "anthropic-auth.json");
  saveAccounts({ version: 1, accounts: [account] }, config);
  return { config, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const accountAt = (now: number, overrides: Partial<Account> = {}): Account => ({
  id: "account-1",
  label: "Personal",
  type: "oauth",
  enabled: true,
  access: "old-access",
  refresh: "old-refresh",
  expires: now + 60 * 60_000,
  ...overrides,
});

test("Claude sidecar tokens become due four hours before expiry", () => {
  const now = 10_000;
  assert.equal(accessTokenNeedsRefresh(accountAt(now), now), true);
  assert.equal(accessTokenNeedsRefresh(accountAt(now, {
    expires: now + ACCESS_REFRESH_WINDOW_MS + 1,
  }), now), false);
});

test("concurrent refresh callers spend a rotating refresh token only once", async () => {
  const now = Date.now();
  const { config, cleanup } = fixture(accountAt(now));
  let calls = 0;
  const refresh = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { access: "new-access", refresh: "new-refresh", expires: now + 8 * 60 * 60_000 };
  };

  try {
    const stored = loadAccounts(config)!.accounts[0]!;
    const [first, second] = await Promise.all([
      ensureAccessToken(stored, { config, now: () => now, refresh }),
      ensureAccessToken(stored, { config, now: () => now, refresh }),
    ]);
    assert.equal(first, "new-access");
    assert.equal(second, "new-access");
    assert.equal(calls, 1);
    assert.equal(loadAccounts(config)!.accounts[0]!.refresh, "new-refresh");
  } finally {
    cleanup();
  }
});

test("credential refresh is independent of quota freshness", async () => {
  const now = Date.now();
  const { config, cleanup } = fixture(accountAt(now, { quota: { checkedAt: now } }));
  let refreshes = 0;

  try {
    const updated = await refreshDueAccessTokens(config, {
      now: () => now,
      refresh: async () => {
        refreshes++;
        return { access: "new-access", refresh: "new-refresh", expires: now + 8 * 60 * 60_000 };
      },
    });
    assert.equal(updated, 1);
    assert.equal(refreshes, 1, "a due credential still rotates");
    assert.equal(loadAccounts(config)!.accounts[0]!.access, "new-access");
  } finally {
    cleanup();
  }
});

test("routing collapses a persisted sidecar that is the primary Claude identity", async () => {
  const now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "pi-plus-anthropic-routing-"));
  const config = join(directory, "anthropic-auth.json");
  const previous = process.env.PI_ANTHROPIC_AUTH_FILE;
  const primary = "sk-ant-oat01-primary-routing-test";
  await anthropicAccountIdentity(primary, async () => new Response(JSON.stringify({
    oauth_account: { account_uuid: "same-user" },
  }), { status: 200 }));
  saveAccounts({
    version: 1,
    main: {
      quota: {
        five_hour: { remainingPercent: 0, resetsAt: new Date(now + 60_000).toISOString() },
      },
    },
    routing: { mode: "sequential" },
    accounts: [
      accountAt(now, { id: "duplicate", identity: "same-user", access: "duplicate-access", expires: now + 8 * 60 * 60_000 }),
      accountAt(now, { id: "secondary", identity: "other-user", access: "secondary-access", expires: now + 8 * 60 * 60_000 }),
    ],
  }, config);

  try {
    process.env.PI_ANTHROPIC_AUTH_FILE = config;
    observeClaudeQuota(primary, {
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor((now + 60_000) / 1000)),
    });
    assert.equal(routeAccessToken(primary), "secondary-access");
  } finally {
    if (previous === undefined) delete process.env.PI_ANTHROPIC_AUTH_FILE;
    else process.env.PI_ANTHROPIC_AUTH_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
