import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { GEMINI_ENDPOINTS, GEMINI_USER_AGENT } from "../src/core/gemini/client.ts";
import { encodeApiKey } from "../src/core/gemini/credentials.ts";
import { STATIC_MODELS } from "../src/core/gemini/models.ts";
import { describeFailure, parseDuration, stream, streamSimple } from "../src/core/gemini/stream.ts";

/**
 * Gemini wraps every SSE frame in `.response`, answers from three
 * endpoints with different capacity, and reports quota resets in the body
 * rather than a header. Each of those is observable only against a stubbed
 * endpoint, so this is where they are pinned.
 */

const model = STATIC_MODELS.find((candidate) => candidate.id === "gemini-3.8-flash")!;
const apiKey = encodeApiKey({ token: "ya29.token", projectId: "proj-1" });

function transcript() {
  const raw: Context = { systemPrompt: "be brief", messages: [{ role: "user", content: "hi", timestamp: 1 }] };
  return normalizeContext(raw);
}

function sse(frames: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const ok = () => sse([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
const failing = (status: number, message: string) => () =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status });

/** Stubs `fetch` with a queue of replies; the last one repeats. */
function endpoint(...replies: Array<() => Response>) {
  const requests: Request[] = [];
  const fetchStub = (async (input: any, init: any) => {
    requests.push(new Request(input, init));
    return (replies.length > 1 ? replies.shift()! : replies[0])();
  }) as typeof fetch;
  return { requests, fetch: fetchStub };
}

async function collect(events: AsyncIterable<any>): Promise<{ types: string[]; message: AssistantMessage }> {
  const types: string[] = [];
  let message: AssistantMessage | undefined;
  for await (const event of events) {
    types.push(event.type);
    if (event.type === "done") message = event.message;
    if (event.type === "error") message = event.error;
  }
  return { types, message: message! };
}

test("text, thinking and tool calls are unwrapped from the response envelope", async () => {
  const server = endpoint(() => sse([
    { response: { responseId: "r-1", candidates: [{ content: { parts: [{ text: "pondering", thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: "Hello" }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: " there" }] } }] } },
    {
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" }, id: "call|1" } }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 30, cachedContentTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 37 },
      },
    },
  ]));
  const { types, message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch }));

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, `${GEMINI_ENDPOINTS[0]}/v1internal:streamGenerateContent?alt=sse`);
  assert.equal(server.requests[0].headers.get("authorization"), "Bearer ya29.token");
  assert.equal(server.requests[0].headers.get("user-agent"), GEMINI_USER_AGENT);

  assert.equal(message.responseId, "r-1");
  assert.deepEqual(message.content.map((item) => item.type), ["thinking", "text", "toolCall"]);
  assert.equal((message.content[1] as any).text, "Hello there");
  // Replayable on Claude: ids are restricted to [A-Za-z0-9_-].
  assert.equal((message.content[2] as any).id, "call_1");
  // A tool call overrides the reported finish reason, or the agent loop stops.
  assert.equal(message.stopReason, "toolUse");
  // promptTokenCount includes the cached tokens; they must not be counted twice.
  assert.deepEqual(
    { input: message.usage.input, cacheRead: message.usage.cacheRead, output: message.usage.output, reasoning: message.usage.reasoning },
    { input: 20, cacheRead: 10, output: 7, reasoning: 2 },
  );
  assert.ok(types.includes("done"));
});

test("the envelope carries the project and runtime model, not the URL", async () => {
  const server = endpoint(ok);
  await collect(streamSimple(model, transcript(), { apiKey, fetch: server.fetch, reasoning: "medium" }));
  const body = JSON.parse(await server.requests[0].text());
  assert.equal(body.project, "proj-1");
  assert.equal(body.model, "gemini-3.8-flash-medium");
  assert.deepEqual(body.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 4000 });
});

test("pi's clamp maps an unadvertised level onto one the model has", async () => {
  const server = endpoint(ok);
  await collect(streamSimple(model, transcript(), { apiKey, fetch: server.fetch, reasoning: "xhigh" }));
  assert.equal(JSON.parse(await server.requests[0].text()).model, "gemini-3.8-flash-high");
});

test("capacity failures fall through to the next endpoint; only the served response is reported", async () => {
  const server = endpoint(failing(503, "No capacity available"), ok);
  const reported: number[] = [];
  const { message } = await collect(stream(model, transcript(), {
    apiKey,
    fetch: server.fetch,
    onResponse: ({ status }) => { reported.push(status); },
  }));

  assert.equal(message.stopReason, "stop");
  assert.deepEqual(server.requests.map((request) => new URL(request.url).origin), GEMINI_ENDPOINTS.slice(0, 2));
  assert.deepEqual(reported, [200]);
});

test("a quota wall stops at once and reports when the account resets", async () => {
  const server = endpoint(failing(429, "Individual quota reached. Resets in 2h5m."));
  const reported: Array<Record<string, string>> = [];
  const { message } = await collect(stream(model, transcript(), {
    apiKey,
    fetch: server.fetch,
    maxRetries: 3,
    onResponse: ({ headers }) => { reported.push(headers); },
  }));

  assert.equal(server.requests.length, 1, "no endpoint fallback and no retry against a quota wall");
  assert.equal(message.stopReason, "error");
  // pi never auto-retries "quota exceeded"; the account pool routes the next request.
  assert.match(message.errorMessage!, /quota exceeded.*429.*resets in 2h5m/i);
  assert.equal(reported[0]["retry-after"], String(2 * 3600 + 5 * 60));
});

test("transient throttling tries every endpoint and stays retryable", async () => {
  const server = endpoint(failing(429, "Rate limit exceeded, slow down."));
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch }));
  assert.equal(server.requests.length, GEMINI_ENDPOINTS.length);
  assert.match(message.errorMessage!, /rate limited.*\(429\)/i);
  assert.doesNotMatch(message.errorMessage!, /quota exceeded/i);
});

test("a malformed request is not retried against other endpoints", async () => {
  const server = endpoint(failing(400, "Invalid JSON payload received. Unknown name \"nullable\""));
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch }));
  assert.equal(server.requests.length, 1);
  assert.match(message.errorMessage!, /request format \(400\)/);
});

test("pi's retry policy retries a transient failure", async () => {
  const server = endpoint(failing(500, "boom"), failing(500, "boom"), failing(500, "boom"), ok);
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch, maxRetries: 1 }));
  assert.equal(message.stopReason, "stop");
  assert.equal(server.requests.length, GEMINI_ENDPOINTS.length + 1);
});

test("an empty stream is replayed before it is reported as a failure", async () => {
  const server = endpoint(() => sse([]));
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch }));
  assert.equal(server.requests.length, 3, "expected the initial attempt plus two replays");
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /empty response/i);
});

test("an error frame inside a 200 stream fails the message", async () => {
  const server = endpoint(() => sse([{ error: { message: "backend exploded" } }]));
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch }));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /backend exploded/);
});

test("a safety stop inside a 200 stream is a failure, not a silent stop", async () => {
  const server = endpoint(() => sse([{ response: { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "SAFETY" }] } }]));
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch }));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /SAFETY/);
});

/** Never answers; rejects on abort the way real `fetch` does, including an already-aborted signal. */
const hanging = (async (_input: any, init: any) => new Promise((_, reject) => {
  if (init.signal.aborted) return reject(init.signal.reason);
  init.signal.addEventListener("abort", () => reject(init.signal.reason));
})) as typeof fetch;

test("a server that never sends headers times out instead of hanging", async () => {
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: hanging, timeoutMs: 20 }));
  assert.equal(message.stopReason, "error");
  // "timed out" is in pi's retryable set.
  assert.match(message.errorMessage!, /timed out: no response headers/);
});

test("a stream that goes silent after its headers times out instead of hanging", async () => {
  let cancelled = false;
  const silent = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "par" }] } }] } })}\n\n`));
      // ...and then nothing, ever.
    },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const server = endpoint(silent);
  const { message } = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch, timeoutMs: 30 }));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /stream timed out: no data/);
  assert.ok(cancelled, "the dead connection is released");
});

test("a caller abort is reported as aborted", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const server = endpoint(ok);
  const early = await collect(stream(model, transcript(), { apiKey, fetch: server.fetch, signal: aborted.signal }));
  assert.equal(early.message.stopReason, "aborted");
  assert.equal(server.requests.length, 0, "nothing is sent after an abort");

  const midway = new AbortController();
  const run = collect(stream(model, transcript(), { apiKey, fetch: hanging, signal: midway.signal }));
  setTimeout(() => midway.abort(), 10);
  assert.equal((await run).message.stopReason, "aborted");
});

test("a missing credential fails the stream instead of throwing at the call site", async () => {
  const { message } = await collect(stream(model, transcript(), {}));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /\/login gemini/);
});

test("failures are phrased so pi's retry policy classifies them correctly", () => {
  assert.equal(describeFailure(429, JSON.stringify({ error: { message: "Resource has been exhausted (e.g. check quota)." } }), "m").quotaWall, false);
  assert.equal(describeFailure(429, "You have exceeded your daily limit", "m").quotaWall, true);
  assert.equal(
    describeFailure(429, JSON.stringify({ error: { message: "slow", details: [{ retryDelay: "30s" }] } }), "m").retryAfterSeconds,
    30,
  );
  assert.match(describeFailure(404, "Requested entity was not found.", "gemini-9-flash-low").message, /gemini-9-flash-low.*\/model/);
  assert.match(describeFailure(503, "No capacity available for model", "m").message, /\(503\)/);
  assert.match(describeFailure(401, "", "m").message, /\/login gemini/);
});

test("reset hints parse into seconds", () => {
  assert.equal(parseDuration("2h5m30s"), 7530);
  assert.equal(parseDuration("45m"), 2700);
  assert.equal(parseDuration("3 hours"), 10_800);
  assert.equal(parseDuration("1d 2h"), 93_600);
  assert.equal(parseDuration("soon"), undefined);
});
