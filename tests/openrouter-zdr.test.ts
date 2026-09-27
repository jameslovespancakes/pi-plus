import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createAgentSession, DefaultResourceLoader, generateSummaryWithUsage, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resetConfigCache } from "../src/core/config.ts";
import { withOpenRouterZdr } from "../src/providers/openrouter/policy.ts";
import { registerPolicyGate } from "../src/domains/models/provider-policy.ts";
import { synchronizeWorkflowModelRuntime } from "../src/domains/workflows/agents/agent-session-providers.ts";

const native = builtinProviders().find((provider) => provider.id === "openrouter")!;
const chatModel = native.getModels().find((model) => model.api === "openai-completions" && !model.reasoning)!;
const messagesModel = native.getModels().find((model) => model.api === "anthropic-messages")!;
const context = () => normalizeContext({
  systemPrompt: "Keep tools available.",
  tools: [{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
});

async function setup(t: any, auto = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-zdr-"));
  const previous = process.env.PI_PLUS_CONFIG;
  const previousDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = dir;
  process.env.PI_PLUS_CONFIG = join(dir, "config.json");
  writeFileSync(process.env.PI_PLUS_CONFIG, JSON.stringify({ policy: {
    autoApprove: auto ? ["openrouter/*"] : [], requireApproval: auto ? [] : ["openrouter/*"], deny: [],
  } }));
  resetConfigCache();
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const providers = new Map<string, any>([["openrouter", native]]);
  const notices: string[] = [];
  const pi: any = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerProvider: (provider: any) => providers.set(provider.id, provider),
  };
  registerPolicyGate(pi);
  const ctx: any = {
    hasUI: false, ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: {
      getProvider: (id: string) => providers.get(id),
      getRegisteredNativeProvider: (id: string) => providers.get(id),
      getAvailable: () => native.getModels(),
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderDisplayName: () => "OpenRouter",
    },
  };
  await handlers.get("session_start")!({}, ctx);
  await commands.get("provider").handler("remove openrouter", ctx);
  t.after(() => {
    handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_PLUS_CONFIG;
    else process.env.PI_PLUS_CONFIG = previous;
    if (previousDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousDir;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, get provider() { return providers.get("openrouter"); }, notices,
    start: () => handlers.get("session_start")!({}, ctx),
    makeLegacyGuard: () => { providers.get("openrouter")[Symbol.for("pi-plus.provider-policy")] = true; },
    reload: async () => {
      handlers.get("session_shutdown")!({}, ctx);
      registerPolicyGate(pi);
      await handlers.get("session_start")!({ reason: "reload" }, ctx);
    },
    command: (args: string) => commands.get("provider").handler(args, ctx) };
}

function success(api: string): Response {
  const frames = api === "anthropic-messages" ? [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: messagesModel.id, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : [
    { id: "chat_test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { id: "chat_test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const body = frames.map((frame) => `${"type" in frame ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function transport(api: string, status = 200) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return status === 200 ? success(api) : Response.json({ error: { code: status, message: "No endpoints found matching your data policy (ZDR)." } }, { status });
  };
  return { requests, fetch };
}

async function finish(stream: AsyncIterable<any>) {
  for await (const event of stream) {
    if (event.type === "done") return event.message;
    if (event.type === "error") return event.error;
  }
  throw new Error("Stream had no terminal event");
}

test("both native OpenRouter APIs and both streaming methods enforce ZDR without losing tools", async (t) => {
  const h = await setup(t);
  await h.command("zdr openrouter");
  assert.equal(h.provider.auth, native.auth);
  assert.equal(h.provider.getModels, native.getModels);
  for (const model of [chatModel, messagesModel]) {
    const original = structuredClone(model);
    for (const method of ["stream", "streamSimple"]) {
      const server = transport(model.api);
      const result = await finish(h.provider[method](model, context(), { apiKey: "test-key", fetch: server.fetch }));
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(server.requests.length, 1);
      const body = await server.requests[0].json();
      assert.equal(body.provider.zdr, true);
      assert.equal(body.tools.length, 1);
      assert.equal(model.api === "anthropic-messages" ? body.tools[0].name : body.tools[0].function.name, "read_file");
    }
    assert.deepEqual(model, original, "catalogue model and compat flags are not mutated");
  }
});

test("Off blocks, normal On preserves configured privacy and routing, and ZDR augments it", async (t) => {
  const h = await setup(t, true);
  const model = { ...chatModel, compat: { ...chatModel.compat, openRouterRouting: { zdr: true, only: ["test"], allow_fallbacks: true } } };
  assert.throws(() => h.provider.streamSimple(model, context(), {}), /OpenRouter is Off/);
  await h.command("approve openrouter");
  for (const mode of ["normal", "zdr"]) {
    if (mode === "zdr") await h.command("zdr openrouter");
    const server = transport(model.api);
    const result = await finish(h.provider.streamSimple(model, context(), { apiKey: "test-key", fetch: server.fetch }));
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual((await server.requests[0].json()).provider, model.compat.openRouterRouting);
  }
  await h.command("");
  assert.match(h.notices.at(-1)!, /\[on\].*OpenRouter: On \(ZDR\)/);
  await h.command("remove openrouter");
  assert.throws(() => h.provider.streamSimple(model, context(), {}), /OpenRouter is Off/);
});

test("unavailable ZDR endpoints surface an error with no unrestricted retry", async (t) => {
  const h = await setup(t);
  await h.command("zdr openrouter");
  for (const model of [chatModel, messagesModel]) {
    const server = transport(model.api, 404);
    const result = await finish(h.provider.streamSimple(model, context(), { apiKey: "test-key", fetch: server.fetch }));
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage.includes("No ZDR endpoint is available for this model. Choose another model to keep ZDR enabled."));
    assert.doesNotMatch(result.errorMessage, /No endpoints found matching/);
    assert.equal(server.requests.length, 1);
    assert.equal((await server.requests[0].json()).provider.zdr, true);
  }
});

test("ZDR error wording is narrow, preserves HTTP semantics, and leaves native errors intact", async () => {
  const friendly = "No ZDR endpoint is available for this model. Choose another model to keep ZDR enabled.";
  for (const message of ["No endpoints found matching your data policy (ZDR).", "No endpoints found for ZDR.", "No endpoints found for zero data retention."]) {
    const original = Response.json({ error: { code: 404, message }, request_id: "request-test" }, {
      status: 404, statusText: "Not Found", headers: { "x-request-id": "request-test", "content-length": "999", "content-encoding": "gzip" },
    });
    const input = new Request("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{}" });
    const init = { signal: new AbortController().signal };
    const request = withOpenRouterZdr(chatModel, { fetch: async (actualInput, actualInit) => {
      assert.equal(actualInput, input);
      assert.equal(actualInit, init);
      return original;
    } });
    const response = await request.options.fetch(input, init);
    assert.equal(response.status, 404);
    assert.equal(response.statusText, "Not Found");
    assert.equal(response.headers.get("x-request-id"), "request-test");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), { error: { code: 404, message: friendly }, request_id: "request-test" });
  }
  for (const original of [
    Response.json({ error: { message: "No endpoints found supporting tools" } }, { status: 404 }),
    Response.json({ error: { message: "Unknown model" } }, { status: 404 }),
    Response.json({ error: { message: "No endpoints found matching your data policy" } }, { status: 403 }),
    Response.json({ error: { message: "Rate limited" } }, { status: 429, headers: { "retry-after": "30" } }),
    new Response("not JSON", { status: 404 }),
    Response.json({ error: null }, { status: 404 }),
    success(chatModel.api),
  ]) {
    const request = withOpenRouterZdr(chatModel, { fetch: async () => original });
    assert.equal(await request.options.fetch("https://openrouter.ai/api/v1/chat/completions"), original);
    assert.equal(original.bodyUsed, false);
  }
  const failure = new Error("transport failed");
  const request = withOpenRouterZdr(chatModel, { fetch: async () => { throw failure; } });
  await assert.rejects(request.options.fetch("https://openrouter.ai/api/v1/chat/completions"), (error) => error === failure);
});

test("normal On does not relabel OpenRouter's routing errors as ZDR failures", async (t) => {
  const h = await setup(t);
  await h.command("approve openrouter");
  const server = transport(chatModel.api, 404);
  const result = await finish(h.provider.streamSimple(chatModel, context(), { apiKey: "test-key", fetch: server.fetch }));
  assert.match(result.errorMessage, /No endpoints.*data policy/);
  assert.doesNotMatch(result.errorMessage, /Choose another model to keep ZDR enabled/);
  assert.equal(server.requests.length, 1);
});

test("payload hooks cannot remove ZDR and unsupported routes fail before transport", async (t) => {
  const h = await setup(t);
  await h.command("zdr openrouter");
  const server = transport(chatModel.api);
  const result = await finish(h.provider.streamSimple(chatModel, context(), {
    apiKey: "test-key", fetch: server.fetch,
    onPayload: (body: any) => ({ ...body, provider: { zdr: false } }),
  }));
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /ZDR was removed.*Nothing was sent/);
  assert.equal(server.requests.length, 0);
  for (const model of [
    { ...chatModel, api: "openai-responses" },
    { ...chatModel, baseUrl: "https://gateway.example/v1" },
  ]) assert.throws(() => h.provider.streamSimple(model, context(), {}), /ZDR can't be enforced/);
  const request = withOpenRouterZdr(messagesModel);
  await assert.rejects(request.options.onPayload({ input: [], instructions: "other API" }, messagesModel), /couldn't verify this request/);
});

test("Messages routing is merged after caller instrumentation; normal On sends no extra ZDR flag", async (t) => {
  const h = await setup(t);
  const server = transport(messagesModel.api);
  await h.command("zdr openrouter");
  await finish(h.provider.streamSimple(messagesModel, context(), {
    apiKey: "test-key", fetch: server.fetch,
    onPayload: (body: any) => ({ ...body, provider: { only: ["test"], zdr: false } }),
  }));
  assert.deepEqual((await server.requests[0].json()).provider, { only: ["test"], zdr: true });
  await h.command("approve openrouter");
  const plain = transport(chatModel.api);
  await finish(h.provider.streamSimple(chatModel, context(), { apiKey: "test-key", fetch: plain.fetch }));
  assert.equal((await plain.requests[0].json()).provider?.zdr, undefined);
});

test("workflow provider synchronization and native summarization retain the same ZDR guard", async (t) => {
  const h = await setup(t);
  await h.command("zdr openrouter");
  const host = await ModelRuntime.create({ authPath: join(h.dir, "host-auth.json"), modelsPath: null, modelsStorePath: join(h.dir, "host-models.json"), refreshOnCreate: false });
  const child = await ModelRuntime.create({ authPath: join(h.dir, "child-auth.json"), modelsPath: null, modelsStorePath: join(h.dir, "child-models.json"), refreshOnCreate: false });
  host.registerNativeProvider(h.provider);
  await synchronizeWorkflowModelRuntime({
    host: {
      getRegisteredProviderIds: () => host.getRegisteredProviderIds(),
      getRegisteredProviderConfig: (id) => host.getRegisteredProviderConfig(id),
      getRegisteredNativeProvider: (id) => host.getRegisteredNativeProvider(id),
      getProviderAuthStatus: (id) => host.getProviderAuthStatus(id),
      isUsingOAuth: (model) => host.isUsingOAuth(model.provider),
      getApiKeyForProvider: async () => undefined,
    },
    child, selectedModel: chatModel, removeChildOnlyProviders: true,
  });
  const childHandlers = new Map<string, Function>();
  registerPolicyGate({
    on: (name: string, fn: Function) => childHandlers.set(name, fn),
    registerCommand: () => {},
    registerProvider: (provider: any) => { assert.fail(`Child must inherit the host guard, not install an unapproved second gate for ${provider.id}`); },
  } as any);
  await childHandlers.get("session_start")!({}, { modelRegistry: child });
  childHandlers.get("session_shutdown")!(); // ending a child must not revoke the host grant
  const server = transport(chatModel.api);
  const result = await finish(child.streamSimple(chatModel, context(), { apiKey: "test-key", fetch: server.fetch }));
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal((await server.requests[0].json()).provider.zdr, true);
  const summaryServer = transport(chatModel.api);
  const summary = await generateSummaryWithUsage(
    [{ role: "user", content: "Preserve this task", timestamp: 1 }], chatModel, 1024, "test-key",
    undefined, undefined, undefined, undefined, "off",
    (model, ctx, options) => child.streamSimple(model, ctx, { ...options, fetch: summaryServer.fetch }),
  );
  assert.equal(summary.text, "ok");
  assert.equal((await summaryServer.requests[0].json()).provider.zdr, true);
  await h.start();
  const blocked = await finish(child.streamSimple(chatModel, context(), { apiKey: "test-key", fetch: server.fetch }));
  assert.equal(blocked.stopReason, "error");
  assert.match(blocked.errorMessage, /Provider access expired/);
  assert.equal(server.requests.length, 1, "session replacement revokes the old inherited grant before transport");
});

test("retired ZDR guards never silently revert to unrestricted auto-approval", async (t) => {
  const h = await setup(t, true);
  await h.command("zdr openrouter");
  const stale = h.provider;
  await h.start();
  assert.throws(() => stale.streamSimple(chatModel, context(), {}), /Provider access expired/);
  await h.command("zdr openrouter");
  const server = transport(chatModel.api);
  const result = await finish(h.provider.streamSimple(chatModel, context(), { apiKey: "test-key", fetch: server.fetch }));
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal((await server.requests[0].json()).provider.zdr, true);
});

test("hot upgrades from v1.0.23 ask for a restart instead of falsely approving a stale guard", async (t) => {
  const h = await setup(t);
  h.makeLegacyGuard();
  await h.reload();
  for (const command of ["approve openrouter", "zdr openrouter", ""]) {
    await h.command(command);
    assert.match(h.notices.at(-1)!, /Restart pi once/);
  }
});

test("native SDK reload connects both On and ZDR controls to the current request guard", async (t) => {
  const h = await setup(t);
  const runtime = await ModelRuntime.create({ authPath: join(h.dir, "auth.json"), modelsPath: null, modelsStorePath: join(h.dir, "models.json"), refreshOnCreate: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: h.dir, agentDir: h.dir, settingsManager, extensionFactories: [registerPolicyGate],
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: h.dir, agentDir: h.dir, modelRuntime: runtime, model: chatModel, thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(h.dir), tools: [],
  });
  t.after(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  await session.prompt("/provider zdr openrouter");
  const stale = runtime.getProvider("openrouter")!;
  for (const command of ["approve", "zdr", "zdr"]) {
    await session.reload();
    await session.prompt(`/provider ${command} openrouter`);
    const server = transport(chatModel.api);
    const result = await runtime.streamSimple(chatModel, context(), { apiKey: "test-key", fetch: server.fetch }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal((await server.requests[0].json()).provider?.zdr, command === "zdr" ? true : undefined);
  }
  assert.deepEqual(errors, []);
  assert.throws(() => stale.streamSimple(chatModel, context(), {}), /session|expired/);
});
