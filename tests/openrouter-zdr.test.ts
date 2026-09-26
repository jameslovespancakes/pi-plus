import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { generateSummaryWithUsage, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resetConfigCache } from "../src/core/config.ts";
import { withOpenRouterZdr } from "../src/core/policy/openrouter.ts";
import { registerPolicyGate } from "../src/domains/models/policy-gate.ts";
import { synchronizeWorkflowModelRuntime } from "../src/domains/workflows/runtime/agent-session-providers.ts";

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
  registerPolicyGate({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerProvider: (provider: any) => providers.set(provider.id, provider),
  } as any);
  const ctx: any = {
    hasUI: false, ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: {
      getProvider: (id: string) => providers.get(id),
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
  return { dir, provider: providers.get("openrouter"), notices,
    start: () => handlers.get("session_start")!({}, ctx),
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
  assert.throws(() => h.provider.streamSimple(model, context(), {}), /not approved/);
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
  assert.throws(() => h.provider.streamSimple(model, context(), {}), /not approved/);
});

test("unavailable ZDR endpoints surface an error with no unrestricted retry", async (t) => {
  const h = await setup(t);
  await h.command("zdr openrouter");
  for (const model of [chatModel, messagesModel]) {
    const server = transport(model.api, 404);
    const result = await finish(h.provider.streamSimple(model, context(), { apiKey: "test-key", fetch: server.fetch }));
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /No endpoints.*data policy/);
    assert.equal(server.requests.length, 1);
    assert.equal((await server.requests[0].json()).provider.zdr, true);
  }
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
  assert.match(result.errorMessage, /blocked a request/);
  assert.equal(server.requests.length, 0);
  for (const model of [
    { ...chatModel, api: "openai-responses" },
    { ...chatModel, baseUrl: "https://gateway.example/v1" },
  ]) assert.throws(() => h.provider.streamSimple(model, context(), {}), /cannot enforce/);
  const request = withOpenRouterZdr(messagesModel);
  await assert.rejects(request.options.onPayload({ input: [], instructions: "other API" }, messagesModel), /unsupported request payload/);
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
  assert.match(blocked.errorMessage, /not approved/);
  assert.equal(server.requests.length, 1, "session replacement revokes the old inherited grant before transport");
});
