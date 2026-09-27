import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { builtinProvider } from "../src/providers/shared/builtin.ts";
import { registerClaudeRouting } from "../src/providers/anthropic/serving.ts";
import { anthropicAccountIdentity } from "../src/providers/anthropic/identity.ts";
import { cachedClaudeCooldown, cachedClaudeQuota } from "../src/providers/anthropic/usage-cache.ts";
import { loadAccounts, saveAccounts } from "../src/providers/anthropic/store.ts";
import { model, message, response } from "./fixtures/provider-stream.ts";

const primaryAccess = "sk-ant-oat01-fixture-primary", secondaryAccess = "sk-ant-oat01-fixture-secondary";
async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), "pi-claude-request-"));
  const previous = process.env.PI_ANTHROPIC_AUTH_FILE;
  process.env.PI_ANTHROPIC_AUTH_FILE = join(directory, "anthropic-auth.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_ANTHROPIC_AUTH_FILE;
    else process.env.PI_ANTHROPIC_AUTH_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  for (const [access, identity] of [[primaryAccess, "primary-native"], [secondaryAccess, "secondary-native"]]) {
    await anthropicAccountIdentity(access, async () => new Response(JSON.stringify({ oauth_account: { account_uuid: identity } }), { status: 200 }));
  }
  const primary = { type: "oauth", access: primaryAccess, refresh: "primary-refresh", expires: Date.now() + 8 * 3_600_000 };
  saveAccounts({ accounts: [{ ...primary, id: "secondary", access: secondaryAccess, refresh: "secondary-refresh", identity: "secondary-native" }] });
  return primary;
}
function success() {
  const events = [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.25" },
  });
}

test("native Anthropic HTTP 429 rotates credentials immediately, preserving model and transcript tools", async (t) => {
  const primary = await fixture(t);
  const usageReads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    assert.match(String(url), /\/api\/oauth\/usage$/);
    usageReads.push(new Headers(init.headers).get("authorization")!);
    return Response.json({ five_hour: { utilization: 20, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 100, resets_at: new Date(Date.now() + 86_400_000).toISOString() } });
  });
  const directory = dirname(process.env.PI_ANTHROPIC_AUTH_FILE!);
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: primary }));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
  registerClaudeRouting({ registerProvider: (value: any) => runtime.registerNativeProvider(value) } as any, builtinProvider("anthropic"), {
    sleep: async () => { assert.fail("a healthy fallback must not wait"); },
  });
  const selected = { ...model, api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" };
  const original = structuredClone(selected);
  const tools = [{ name: "read", description: "Read a fixture", parameters: Type.Object({ path: Type.String() }) }];
  const context = { messages: [{ role: "system", content: "Fixture", toolsAdded: tools, timestamp: 1 }, { role: "user", content: "Reply OK", timestamp: 2 }], tools };
  const requests: Request[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.headers.get("authorization")?.includes(primaryAccess)) {
      return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This account is limited." } }), {
        status: 429, headers: { "content-type": "application/json", "retry-after": "10" },
      });
    }
    assert.match(request.headers.get("authorization") ?? "", /fixture-secondary/);
    return success();
  };
  const result = await runtime.streamSimple(selected as any, context as any, { fetch: transport }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(requests.length, 2, "native retries must not multiply pooled attempts");
  const bodies = await Promise.all(requests.map((request) => request.json()));
  assert.equal(bodies[0].model, selected.id);
  assert.equal(bodies[1].model, selected.id);
  assert.equal(bodies[0].tools.length, 1);
  assert.deepEqual(bodies[1].tools, bodies[0].tools);
  assert.deepEqual(bodies[1].messages, bodies[0].messages);
  assert.deepEqual(selected, original, "the wrapper does not mutate pi's model or compat");
  assert.ok(cachedClaudeCooldown({ access: primaryAccess }, selected.id));
  assert.equal(cachedClaudeQuota({ access: secondaryAccess })?.five_hour?.remainingPercent, 75);
  assert.equal(loadAccounts()!.accounts[0].refresh, "secondary-refresh");
  assert.deepEqual(usageReads, [`Bearer ${primaryAccess}`], "usage belongs to the actual failed credential");
  assert.equal(cachedClaudeQuota({ access: primaryAccess })?.seven_day?.remainingPercent, 0);
  const afterCooldown = Date.now() + 20_000;
  t.mock.method(Date, "now", () => afterCooldown);
  assert.equal((await runtime.streamSimple(selected as any, context as any, { fetch: transport }).result()).stopReason, "stop");
  assert.equal(requests.length, 3);
  assert.match(requests[2].headers.get("authorization") ?? "", /fixture-secondary/, "known weekly exhaustion outlives the temporary cooldown");
  assert.equal(usageReads.length, 1);
});

test("Claude serving uses actual model-scoped quota and retains the native wrapper across inherited registrations", async (t) => {
  const primary = await fixture(t);
  const storage = loadAccounts()!;
  storage.accounts.push({ ...primary, id: "primary-copy", identity: "primary-native", quota: {
    checkedAt: Date.now(), five_hour: { remainingPercent: 90 }, seven_day: { remainingPercent: 80 },
    scoped: [{ id: "Claude Opus 5.5", remainingPercent: 0, resetsAt: new Date(Date.now() + 60000).toISOString() }],
  } });
  saveAccounts(storage);
  const sent: any[] = [];
  const base = builtinProvider("anthropic");
  const stream = (selected: any, _context: any, options: any) => { sent.push({ selected, apiKey: options.apiKey }); return response(message()); };
  let provider: any;
  const pi = { registerProvider: (value: any) => { provider = value; } } as any;
  registerClaudeRouting(pi, { ...base, stream, streamSimple: stream } as any, { sleep: async () => { assert.fail("healthy account available"); } });
  const inherited = provider;
  registerClaudeRouting(pi, inherited);
  assert.equal(provider, inherited, "workflow inheritance must not stack another recovery budget");
  const auth = await provider.auth.oauth.toAuth(primary);
  await provider.streamSimple({ ...model, id: "claude-opus-5-5" }, {}, auth).result();
  await provider.streamSimple({ ...model, id: "claude-sonnet-4-6" }, {}, auth).result();
  assert.deepEqual(sent.map((attempt) => attempt.apiKey), [secondaryAccess, primaryAccess]);
});
