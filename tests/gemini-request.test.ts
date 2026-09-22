import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Context, Message, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { STATIC_MODELS } from "../src/core/gemini/models.ts";
import {
  CONTINUE_TEXT,
  buildRequest,
  repairContents,
  requiresThoughtSignatures,
  type Content,
} from "../src/core/gemini/request.ts";

/**
 * pi 0.87 keeps the system prompt and the tool set inside the transcript's
 * system messages, not on the context object. An adapter that reads
 * `context.systemPrompt` / `context.tools` gets undefined and sends neither,
 * with no error anywhere — so that is asserted first.
 */

const flash = STATIC_MODELS.find((model) => model.id === "gemini-3.8-flash")!;
const claude = STATIC_MODELS.find((model) => model.id === "claude-sonnet-4-6")!;

const readFile: Tool = {
  name: "read_file",
  description: "Read a file",
  parameters: Type.Object({ path: Type.String({ format: "uri" }) }),
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function context(messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }], options: { systemPrompt?: string; tools?: Tool[] } = {}) {
  const raw: Context = { systemPrompt: options.systemPrompt, tools: options.tools, messages };
  return normalizeContext(raw);
}

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "gemini",
    provider: "gemini",
    model: "gemini-3.8-flash",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
    ...overrides,
  };
}

/** A tool round trip, as `from` produced it. */
function toolRound(from: Partial<AssistantMessage>, thoughtSignature?: string): Message[] {
  return [
    { role: "user", content: "read a.ts", timestamp: 1 },
    assistant({
      ...from,
      content: [
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.ts" }, ...(thoughtSignature && { thoughtSignature }) },
      ],
    }),
    { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: [{ type: "text", text: "export {}" }], isError: false, timestamp: 3 },
  ];
}

test("the system prompt and tools are read from the transcript", async () => {
  const request = await buildRequest(flash, context(undefined, { systemPrompt: "You are pi.", tools: [readFile] }), "proj-1");
  assert.deepEqual(request.request.systemInstruction, { role: "user", parts: [{ text: "You are pi." }] });
  const tools = request.request.tools as { functionDeclarations: any[] }[];
  assert.deepEqual(tools[0].functionDeclarations.map((fn) => fn.name), ["read_file"]);
});

test("the envelope names the runtime model, the project and the agent request type", async () => {
  const request = await buildRequest(flash, context(), "proj-1", { reasoning: "high", sessionId: "session-1" });
  assert.equal(request.project, "proj-1");
  assert.equal(request.model, "gemini-3.8-flash-high");
  assert.equal(request.requestType, "agent");
  assert.equal(request.userAgent, "antigravity");
  assert.match(request.requestId, /^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/);
  assert.equal(request.request.sessionId, "session-1");
  assert.deepEqual(Object.keys(request.request.labels as object).sort(), [
    "last_step_index", "request_id", "trajectory_id", "used_claude", "used_claude_conservative", "used_non_gemini_model",
  ]);
});

test("one session keeps one trajectory across requests", async () => {
  const first = await buildRequest(flash, context(), "p", { sessionId: "s" });
  const second = await buildRequest(flash, context(), "p", { sessionId: "s" });
  const other = await buildRequest(flash, context(), "p", { sessionId: "t" });
  const trajectory = (request: typeof first) => (request.request.labels as any).trajectory_id;
  assert.equal(trajectory(first), trajectory(second));
  assert.notEqual(trajectory(first), trajectory(other));
});

test("thinking is sent as the runtime family's integer budget", async () => {
  const config = async (reasoning?: any) =>
    ((await buildRequest(flash, context(), "p", { reasoning })).request.generationConfig as any).thinkingConfig;
  assert.deepEqual(await config("high"), { includeThoughts: true, thinkingBudget: -1 });
  assert.deepEqual(await config("low"), { includeThoughts: true, thinkingBudget: 1000 });
  assert.deepEqual(await config(), { includeThoughts: false, thinkingBudget: 0 });
});

test("the output ceiling never exceeds what the backend accepts", async () => {
  const max = async (maxTokens?: number) =>
    ((await buildRequest(flash, context(), "p", { maxTokens })).request.generationConfig as any).maxOutputTokens;
  assert.equal(await max(), flash.maxTokens);
  assert.equal(await max(1000), 1000);
  assert.equal(await max(10_000_000), flash.maxTokens);
});

test("Gemini gets JSON Schema; Claude gets the bridge's parameters subset", async () => {
  const transcript = context(undefined, { systemPrompt: "x", tools: [readFile] });
  const declaration = async (model: typeof flash, reasoning?: any) =>
    ((await buildRequest(model, transcript, "p", { reasoning })).request.tools as any)[0].functionDeclarations[0];

  const gemini = await declaration(flash);
  assert.equal(gemini.parameters, undefined);
  assert.equal(gemini.parametersJsonSchema.properties.path.format, "uri");

  const bridged = await declaration(claude, "high");
  assert.equal(bridged.parametersJsonSchema, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(bridged.parameters.properties.path)), { type: "string" });
});

test("the function calling mode follows pi, which omits it unless asked", async () => {
  const transcript = context(undefined, { systemPrompt: "x", tools: [readFile] });
  assert.equal((await buildRequest(flash, transcript, "p")).request.toolConfig, undefined);
  assert.deepEqual((await buildRequest(flash, transcript, "p", { toolChoice: "none" })).request.toolConfig, {
    functionCallingConfig: { mode: "NONE" },
  });
});

test("Gemini 3 replays another model's tool calls as observations", async () => {
  const request = await buildRequest(flash, context(toolRound({ api: "anthropic-messages", provider: "anthropic", model: "claude-x" })), "p");
  const contents = request.request.contents as Content[];

  assert.ok(!contents.some((turn) => turn.parts.some((part) => part.functionCall || part.functionResponse)));
  const texts = contents.flatMap((turn) => turn.parts.map((part) => part.text));
  assert.ok(texts.includes("[Observation from `read_file` ({\"path\":\"a.ts\"}):\nexport {}]"), texts.join(" | "));
  assert.equal(contents.at(-1)!.role, "user");
});

test("a signed tool call from the same model is replayed as a call", async () => {
  const request = await buildRequest(flash, context(toolRound({}, "c2lnbmF0dXJl")), "p");
  const parts = (request.request.contents as Content[]).flatMap((turn) => turn.parts);
  const call = parts.find((part) => part.functionCall)!;
  assert.equal(call.thoughtSignature, "c2lnbmF0dXJl");
  assert.equal(call.functionCall!.id, "call_1");
  assert.ok(parts.some((part) => part.functionResponse?.id === "call_1"));
});

test("Claude needs no signatures, so unsigned calls stay calls", async () => {
  const request = await buildRequest(claude, context(toolRound({ provider: "anthropic", model: "claude-x" })), "p", { reasoning: "high" });
  assert.ok((request.request.contents as Content[]).some((turn) => turn.parts.some((part) => part.functionCall)));
  assert.equal(requiresThoughtSignatures("claude-sonnet-4-6"), false);
  assert.equal(requiresThoughtSignatures("gemini-pro-agent"), true);
  assert.equal(requiresThoughtSignatures("gemini-2.5-flash"), false);
});

test("conversation shapes Gemini rejects are repaired", () => {
  const bridge = { text: CONTINUE_TEXT };

  // A conversation must open with a user turn.
  assert.deepEqual(repairContents([{ role: "model", parts: [{ text: "hi" }] }, { role: "user", parts: [{ text: "go" }] }], false), [
    { role: "user", parts: [bridge] },
    { role: "model", parts: [{ text: "hi" }] },
    { role: "user", parts: [{ text: "go" }] },
  ]);

  // Some natural-language user text must exist; a tool-only history gets one.
  const toolOnly = repairContents([{ role: "user", parts: [{ functionResponse: { name: "t", response: { output: "x" } } }] }], false);
  assert.deepEqual(toolOnly[0].parts.at(-1), bridge);

  // A request may not end on a model turn.
  assert.deepEqual(repairContents([{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b" }] }], false).at(-1), {
    role: "user", parts: [bridge],
  });

  // Adjacent same-role turns become one.
  assert.equal(repairContents([{ role: "user", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "b" }] }], false).length, 1);
});

test("an empty transcript still sends a valid conversation", () => {
  assert.deepEqual(repairContents([], false), [{ role: "user", parts: [{ text: CONTINUE_TEXT }] }]);
});
