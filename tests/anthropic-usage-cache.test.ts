import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLease } from "../src/core/file-lease.ts";
import { cachedClaudeQuota, observeClaudeQuota, readClaudeQuota, QUOTA_BACKOFF_MS } from "../src/core/anthropic/usage-cache.ts";
import { parseQuota, QUOTA_FRESH_MS } from "../src/core/anthropic/quota.ts";
import { saveAccounts, loadAccounts } from "../src/core/anthropic/store.ts";
import { registerAnthropicProvider } from "../src/domains/subscriptions/provider.ts";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-claude-usage-"));
  const previous = process.env.PI_ANTHROPIC_AUTH_FILE;
  const originalFetch = globalThis.fetch;
  process.env.PI_ANTHROPIC_AUTH_FILE = join(dir, "anthropic-auth.json");
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  try { await run(dir); }
  finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.PI_ANTHROPIC_AUTH_FILE;
    else process.env.PI_ANTHROPIC_AUTH_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
const account = { access: "sk-ant-oat-test-secret", identity: "test-account" };
const body = { five_hour: { utilization: 20 }, seven_day: { utilization: 40 } };
function childRead(target = account) {
  const module = new URL("../src/core/anthropic/usage-cache.ts", import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { readClaudeQuota } = await import(${JSON.stringify(module)});
    let calls=0; globalThis.fetch=async()=>{calls++;throw new Error('Unexpected network');};
    const result=await readClaudeQuota(${JSON.stringify(target)});
    console.log(JSON.stringify({calls,...result}));
  `], { env, encoding: "utf8", timeout: 15_000 }));
}

test("one status request serves repeated calls and a rotated token with the same identity", async () => fixture(async (dir) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(body); };
  const first = await readClaudeQuota(account);
  const second = await readClaudeQuota({ ...account, access: "rotated-token" });
  assert.equal(calls, 1);
  assert.equal(first.quota?.five_hour?.remainingPercent, 80);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.equal(childRead().calls, 0);
  for (const name of readdirSync(dir)) {
    assert.doesNotMatch(name + readFileSync(join(dir, name), "utf8"), /sk-ant-oat-test-secret|rotated-token/);
  }
}));

test("429 cooldown survives a new process and grows on repeated failures", async () => fixture(async () => {
  const now = Date.now();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "0" } }); };
  assert.equal((await readClaudeQuota(account, now)).error, "HTTP 429");
  assert.equal(childRead().error, "HTTP 429");
  assert.equal(childRead().calls, 0);
  await readClaudeQuota(account, now + QUOTA_BACKOFF_MS - 1);
  assert.equal(calls, 1);
  await readClaudeQuota(account, now + QUOTA_BACKOFF_MS);
  assert.equal(calls, 2);
  await readClaudeQuota(account, now + 3 * QUOTA_BACKOFF_MS - 1);
  assert.equal(calls, 2, "second failure waits 30 minutes");
  globalThis.fetch = async () => { calls++; return Response.json(body); };
  const recovered = await readClaudeQuota(account, now + 3 * QUOTA_BACKOFF_MS);
  assert.equal(calls, 3);
  assert.equal(recovered.error, undefined);
}));

test("discovering an identity does not bypass an existing token cooldown", async () => fixture(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 429 }); };
  await readClaudeQuota({ access: account.access });
  assert.equal((await readClaudeQuota(account)).error, "HTTP 429");
  assert.equal(calls, 1);
}));

test("both Retry-After seconds and dates are respected", async () => fixture(async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  for (const [index, hint] of ["3600", new Date(now + 3_600_000).toUTCString()].entries()) {
    const target = { access: `sk-ant-oat-hint-${index}`, identity: `hint-${index}` };
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": hint } }); };
    await readClaudeQuota(target, now);
    await readClaudeQuota(target, now + 3_600_000 - 1);
    assert.equal(calls, 1);
    await readClaudeQuota(target, now + 3_600_000);
    assert.equal(calls, 2);
  }
}));

test("a cross-process lease prevents overlapping status requests", async () => fixture(async () => {
  let release!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { release = resolve; });
  const pending = readClaudeQuota(account);
  try {
    assert.equal(childRead().calls, 0);
    assert.equal((await readClaudeQuota(account)).quota, undefined);
  } finally { release(Response.json(body)); await pending; }
}));

test("header observations refresh unchanged percentages and preserve missing windows", async () => fixture(async () => {
  const now = Date.now();
  const tokenOnly = { access: "sk-ant-oat-primary" };
  globalThis.fetch = async () => Response.json({
    ...body, five_hour: { utilization: 20, resets_at: "2030-01-01T00:00:00Z", limit_dollars: 100 },
    seven_day_opus: { utilization: 50 }, extra_usage: { is_enabled: true, utilization: 5 },
  });
  await readClaudeQuota(tokenOnly, now);
  observeClaudeQuota(tokenOnly.access, { "anthropic-ratelimit-unified-5h-utilization": "0.2" }, now + 60_000);
  const quota = cachedClaudeQuota(tokenOnly)!;
  assert.equal(quota.checkedAt, now + 60_000);
  assert.equal(quota.five_hour?.checkedAt, now + 60_000);
  assert.equal(quota.five_hour?.capacity, 100);
  assert.equal(quota.five_hour?.resetsAt, "2030-01-01T00:00:00Z");
  assert.equal(quota.seven_day?.checkedAt, now, "missing headers cannot freshen another window");
  assert.equal(quota.seven_day?.remainingPercent, 60);
  assert.equal(quota.scoped?.[0].id, "opus");
  assert.equal(quota.extra?.remainingPercent, 95);
  globalThis.fetch = async () => { throw new Error("Headers must avoid polling"); };
  assert.equal((await readClaudeQuota(tokenOnly, now + 60_000)).error, undefined);
}));

test("fresh partial headers do not hide an old weekly window from the fallback", async () => fixture(async () => {
  const now = Date.now();
  const target = { access: "sk-ant-oat-partial" };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(body); };
  await readClaudeQuota(target, now);
  observeClaudeQuota(target.access, { "anthropic-ratelimit-unified-5h-utilization": "0.2" }, now + QUOTA_FRESH_MS + 1);
  await readClaudeQuota(target, now + QUOTA_FRESH_MS + 1);
  assert.equal(calls, 2);
}));

test("status failures retain old observations without changing OAuth credentials", async () => fixture(async () => {
  const now = Date.now();
  const legacy = parseQuota(body, now - QUOTA_FRESH_MS - 1);
  saveAccounts({ accounts: [{ ...account, id: "pooled", type: "oauth", refresh: "keep-refresh", expires: now + 1000, quota: legacy }] });
  const before = loadAccounts();
  globalThis.fetch = async () => new Response(null, { status: 429 });
  const result = await readClaudeQuota({ ...account, quota: legacy }, now);
  assert.equal(result.quota?.five_hour?.checkedAt, legacy.five_hour?.checkedAt);
  assert.deepEqual(loadAccounts(), before);
}));

test("parallel session hooks attribute primary and pooled headers to their actual bearer token", async () => fixture(async () => {
  const primary = "sk-ant-oat-primary-hooks", secondary = "sk-ant-oat-secondary-hooks";
  saveAccounts({ accounts: [{ id: "second", type: "oauth", access: secondary, identity: "second-id" }] });
  const handlers = () => {
    const hooks = new Map<string, (event: any) => void>();
    registerAnthropicProvider({ registerProvider() {}, registerCommand() {}, on: (name: string, fn: any) => { hooks.set(name, fn); } } as any);
    return hooks;
  };
  const a = handlers(), b = handlers();
  a.get("before_provider_headers")!({ headers: { Authorization: `Bearer ${primary}` } });
  b.get("before_provider_headers")!({ headers: { authorization: `Bearer ${secondary}` } });
  a.get("after_provider_response")!({ headers: { "anthropic-ratelimit-unified-5h-utilization": "0.1" } });
  b.get("after_provider_response")!({ headers: { "anthropic-ratelimit-unified-5h-utilization": "0.7" } });
  assert.equal(cachedClaudeQuota({ access: primary })?.five_hour?.remainingPercent, 90);
  assert.equal(cachedClaudeQuota({ access: secondary, identity: "second-id" })?.five_hour?.remainingPercent, 30);
  // A later unrelated provider response must not reuse either credential.
  a.get("after_provider_response")!({ headers: { "anthropic-ratelimit-unified-5h-utilization": "1" } });
  assert.equal(cachedClaudeQuota({ access: primary })?.five_hour?.remainingPercent, 90);
}));

test("a partially written lease cannot be mistaken for a stale lock", async () => fixture(async (dir) => {
  const path = join(dir, "lease.lock");
  writeFileSync(path, "");
  assert.equal(acquireFileLease(path, 60_000), undefined);
  const lease = acquireFileLease(path, 60_000, Date.now() + 120_000);
  assert.ok(lease);
  lease.release();
}));
