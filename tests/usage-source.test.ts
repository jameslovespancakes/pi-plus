import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOAuthPoolCache, saveOAuthAccount, setPrimaryQuota } from "../src/core/accounts/oauth-pool.ts";
import { parseQuota } from "../src/core/anthropic/quota.ts";
import { saveAccounts } from "../src/core/anthropic/store.ts";
import {
  fetchClaudeRows,
  fetchCodexRows,
  fetchGeminiRows,
  observedRows,
} from "../src/core/quota/usage-source.ts";

const HOUR = 3_600_000;

/** A registry that fails the test if the routed credential is ever asked for. */
const noRouting = {
  modelRegistry: {
    getProviderAuth: async (provider: string) => {
      throw new Error(`routed auth requested for ${provider}`);
    },
  },
};

async function withFetch(
  handler: (url: string, init: RequestInit & { headers?: Record<string, string> }) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: any) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function withTempFiles(run: () => Promise<void>): Promise<void> {
  const dir = join(tmpdir(), `pi-plus-usage-${randomUUID()}`);
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = join(dir, "oauth.json");
  process.env.PI_ANTHROPIC_AUTH_FILE = join(dir, "anthropic-auth.json");
  resetOAuthPoolCache();
  try {
    await run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
    delete process.env.PI_ANTHROPIC_AUTH_FILE;
    resetOAuthPoolCache();
  }
}

const bearer = (init: { headers?: Record<string, string> }) => init.headers?.Authorization?.replace(/^Bearer /, "");

test("parseQuota ignores the unscoped restatements in `limits`", () => {
  // Shape captured from /api/oauth/usage: the session and weekly windows are
  // repeated in `limits` with no scope; only the Fable entry is a real limit.
  const quota = parseQuota({
    five_hour: { utilization: 11, resets_at: "2026-09-23T00:50:00Z" },
    seven_day: { utilization: 1, resets_at: "2026-09-29T23:00:00Z" },
    limits: [
      { kind: "session", percent: 11, resets_at: "2026-09-23T00:50:00Z", scope: null },
      { kind: "weekly_all", percent: 1, resets_at: "2026-09-29T23:00:00Z", scope: null },
      { kind: "weekly_scoped", percent: 0, resets_at: "2026-09-29T23:00:00Z", scope: { model: { display_name: "Fable" } } },
    ],
  });
  assert.deepEqual(quota.scoped?.map((window) => [window.id, window.remainingPercent]), [["fable", 100]]);
});

test("Gemini rows come from the stored primary and each distinct pooled account", async () => {
  await withTempFiles(async () => {
    saveOAuthAccount("gemini", {
      type: "oauth", id: "a1", label: "Second", access: "ya29.second", refresh: "r", expires: Date.now() + HOUR,
      addedAt: 1, projectId: "project-second", email: "second@example.com",
    } as any);
    // The primary's own Google account, signed in again: one allowance, not two.
    saveOAuthAccount("gemini", {
      type: "oauth", id: "a2", label: "Dupe", access: "ya29.dupe", refresh: "r", expires: Date.now() + HOUR,
      addedAt: 2, projectId: "project-main", email: "Main@Example.com",
    } as any);

    const asked: string[] = [];
    await withFetch((url, init) => {
      assert.match(url, /retrieveUserQuota$/);
      asked.push(`${bearer(init)}:${JSON.parse(String(init.body)).project}`);
      const fraction = bearer(init) === "ya29.main" ? 0.75 : 0.5;
      return Response.json({
        buckets: [
          { modelId: "gemini-3.8-flash-high", remainingFraction: fraction, resetTime: "2026-09-29T17:43:59Z" },
          { modelId: "gemini-pro-agent", remainingFraction: 1, resetTime: "2026-09-29T17:43:59Z" },
        ],
      });
    }, async () => {
      const result = await fetchGeminiRows(noRouting, {
        readCredential: (provider) => provider === "gemini"
          ? { type: "oauth", access: "ya29.main", refresh: "r", expires: Date.now() + HOUR, projectId: "project-main", email: "main@example.com" }
          : undefined,
      });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.groups, ["Gemini Primary", "Gemini Second"]);
      assert.deepEqual(asked.sort(), ["ya29.main:project-main", "ya29.second:project-second"]);
      assert.deepEqual(
        result.rows.map((row) => [row.group, row.label, row.remaining]),
        [
          ["Gemini Primary", "Flash", 75],
          ["Gemini Primary", "Pro", 100],
          ["Gemini Second", "Flash", 50],
          ["Gemini Second", "Pro", 100],
        ],
      );
      assert.ok(result.rows.every((row) => typeof row.checkedAt === "number"), "rows must be poolable");
    });
  });
});

test("a verification-blocked second Gemini account does not hide primary quota", async () => {
  await withTempFiles(async () => {
    saveOAuthAccount("gemini", {
      type: "oauth", id: "second", label: "Second", access: "ya29.second", refresh: "r",
      expires: Date.now() + HOUR, addedAt: 1,
    });
    await withFetch((url, init) => {
      assert.match(url, /retrieveUserQuota$/);
      return bearer(init) === "ya29.second"
        ? Response.json({ error: { message: "Verify your account to continue." } }, { status: 403 })
        : Response.json({ buckets: [{ modelId: "gemini-pro-agent", remainingFraction: 0.75 }] });
    }, async () => {
      const result = await fetchGeminiRows(noRouting, {
        readCredential: () => ({ type: "oauth", access: "ya29.main", expires: Date.now() + HOUR }),
      });
      assert.deepEqual(result.groups, ["Gemini Primary", "Gemini Second"]);
      assert.deepEqual(result.rows.map((row) => [row.group, row.label, row.remaining]), [["Gemini Primary", "Pro", 75]]);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0], /^Gemini Second: Google account verification required/);
      assert.match(result.errors[0], /\/accounts reauth gemini Second/);
    });
  });
});

test("Gemini stays silent without a login and reports a failing account by name", async () => {
  await withTempFiles(async () => {
    const none = await fetchGeminiRows(noRouting, { readCredential: () => undefined });
    assert.deepEqual(none, { rows: [], errors: [], groups: [] });

    await withFetch(() => new Response("denied", { status: 403 }), async () => {
      const failed = await fetchGeminiRows(noRouting, {
        readCredential: () => ({ type: "oauth", access: "ya29.main", refresh: "r", expires: Date.now() + HOUR, projectId: "p" }),
      });
      assert.deepEqual(failed.groups, ["Gemini Primary"], "still expected, so its last figures are kept");
      assert.equal(failed.errors.length, 1);
      assert.match(failed.errors[0], /^Gemini Primary: /);
    });
  });
});

test("an expiring primary is refreshed by pi, then read back", async () => {
  await withTempFiles(async () => {
    let stored: any = { type: "oauth", access: "ya29.old", refresh: "r", expires: Date.now() - 1, projectId: "p" };
    const ctx = {
      modelRegistry: {
        getProviderAuth: async (provider: string) => {
          assert.equal(provider, "gemini");
          stored = { ...stored, access: "ya29.new", expires: Date.now() + HOUR };
          return { auth: { apiKey: "routed-elsewhere" } };
        },
      },
    };
    const used: string[] = [];
    await withFetch((_url, init) => {
      used.push(bearer(init)!);
      return Response.json({ buckets: [{ modelId: "gemini-3.8-flash-high", remainingFraction: 1 }] });
    }, async () => {
      const result = await fetchGeminiRows(ctx, { readCredential: () => stored });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(used, ["ya29.new"], "the stored token, never the routed apiKey");
    });
  });
});

test("Claude's primary is read as stored and not double counted with its pooled twin", async () => {
  await withTempFiles(async () => {
    saveAccounts({
      version: 1,
      accounts: [
        {
          id: "p1", label: "Personal", type: "oauth", enabled: true, identity: "uuid-personal",
          access: "sk-ant-oat-personal", expires: Date.now() + HOUR,
          quota: {
            five_hour: { remainingPercent: 89, resetsAt: "2026-09-23T00:50:00Z", checkedAt: Date.now() },
            seven_day: { remainingPercent: 99, checkedAt: Date.now() },
            scoped: [
              // Written before the parse fix: a restated window, not a limit.
              { id: "scoped", remainingPercent: 89, checkedAt: Date.now() },
              { id: "fable", remainingPercent: 100, checkedAt: Date.now() },
            ],
            checkedAt: Date.now(),
          },
        },
      ],
    });

    const usagePolled: string[] = [];
    await withFetch((url, init) => {
      if (url.includes("/api/claude_cli/bootstrap")) {
        return Response.json({ oauth_account: { account_uuid: bearer(init) === "sk-ant-oat-main" ? "uuid-personal" : "other" } });
      }
      usagePolled.push(url);
      return new Response("unexpected", { status: 500 });
    }, async () => {
      const result = await fetchClaudeRows(noRouting, {
        readCredential: (provider) => provider === "anthropic"
          ? { type: "oauth", access: "sk-ant-oat-main", refresh: "r", expires: Date.now() + HOUR }
          : undefined,
      });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(usagePolled, [], "the twin's stored snapshot covers the primary");
      assert.deepEqual(result.groups, ["Claude Personal"]);
      assert.deepEqual(
        result.rows.map((row) => [row.group, row.label, row.remaining]),
        [
          ["Claude Personal", "5h", 89],
          ["Claude Personal", "7d", 99],
          ["Claude Personal", "7d fable", 100],
        ],
      );
    });
  });
});

test("Codex asks about the account its token belongs to", async () => {
  const seen: Array<string | undefined> = [];
  await withFetch((_url, init) => {
    seen.push(init.headers?.["ChatGPT-Account-Id"]);
    return Response.json({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 82, limit_window_seconds: 604800, reset_at: 1790425696 }, secondary_window: null },
    });
  }, async () => {
    const result = await fetchCodexRows(noRouting, {
      readCredential: () => ({ type: "oauth", access: "token", refresh: "r", expires: Date.now() + HOUR, accountId: "acct-main" }),
    });
    assert.deepEqual(seen, ["acct-main"]);
    assert.equal(result.plan, "pro");
    assert.deepEqual(result.rows.map((row) => [row.label, row.remaining]), [["weekly", 18]]);
  });
});

test("header-observed providers report only a live reading", async () => {
  await withTempFiles(async () => {
    const now = Date.now();
    assert.deepEqual(observedRows(now), [], "nothing observed yet");

    setPrimaryQuota("xai", { remainingPercent: 0, checkedAt: now - 20 * 60_000, blockedUntil: now + 60_000 });
    setPrimaryQuota("kimi-coding", { remainingPercent: 40, checkedAt: now - 60 * 60_000 });
    const rows = observedRows(now);
    assert.deepEqual(rows.map((row) => [row.group, row.label, row.remaining]), [["Grok", "rate", 0]],
      "an old reading lapses; a live block stays however old");
    assert.equal(rows[0].resetAt, now + 60_000);
  });
});
