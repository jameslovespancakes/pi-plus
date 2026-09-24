import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeRemoteBridge, type BridgeOptions } from "../src/core/claude-remote/bridge.ts";
import { inboundText, mirrorMessage, parseSSE, RecentIds } from "../src/core/claude-remote/protocol.ts";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("Timed out waiting for bridge");
    await delay(5);
  }
}

function harness(overrides: Partial<BridgeOptions> = {}) {
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const connected: string[] = [];
  let interrupts = 0;
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let handler: ((url: string, init: RequestInit) => Response | Promise<Response> | undefined) | undefined;
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    init.signal?.throwIfAborted();
    requests.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const handled = await handler?.(url, init);
    if (handled) return handled;
    if (url.endsWith("/bridge")) return Response.json({
      worker_jwt: "worker-secret", api_base_url: "https://worker.example", expires_in: 3600, worker_epoch: "1",
    });
    if (url.endsWith("/sessions")) return Response.json({ session: { id: "cse_example" } });
    if (url.includes("/events/stream")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          init.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch {} }, { once: true });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const bridge = new ClaudeRemoteBridge({
    title: "pi: test", getAccessToken: async () => "oauth-secret", allowInbound: true,
    trustedDeviceToken: "device-secret", onText: (text) => texts.push(text), onInterrupt: () => { interrupts++; },
    onConnect: (id) => connected.push(id), onError: (error) => errors.push(error), fetch: fetcher, ...overrides,
  });
  return {
    bridge, requests, texts, errors, connected, streams,
    get interrupts() { return interrupts; },
    handle(fn: NonNullable<typeof handler>) { handler = fn; },
    push(payload: unknown, id = "event-1", seq = 1) {
      streams.at(-1)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ event_id: id, sequence_num: seq, payload })}\n\n`));
    },
    events() { return requests.filter((request) => request.url.endsWith("/events")).flatMap((request) => request.body.events.map((event: any) => event.payload)); },
  };
}

test("SSE handles chunked CRLF, multiline data and keepalive comments", () => {
  assert.deepEqual(parseSSE(":ping\n\ndata: {\r\ndata: }\r\n\r"), { frames: [], remaining: "data: {\ndata: }\n\r" });
  const first = parseSSE("data: one\r\n\r");
  assert.deepEqual(parseSSE(first.remaining + "\ndata: two\n\npartial"), { frames: ["one", "two"], remaining: "partial" });
});

test("translation uses pi roles, preserves tool IDs/images and ignores custom/system messages", () => {
  const result = mirrorMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", isError: true,
    content: [{ type: "text", text: "failed" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 });
  assert.deepEqual((result!.message as any).content, [{ type: "tool_result", tool_use_id: "call-1", is_error: true,
    content: [{ type: "text", text: "failed" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }]);
  const assistant = mirrorMessage({ role: "assistant", model: "gpt-test", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "hmm", thinkingSignature: "sig" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
  ] } as any);
  assert.equal((assistant!.message as any).stop_reason, "tool_use");
  assert.equal((assistant!.message as any).content[1].id, "call-1");
  assert.equal(mirrorMessage({ role: "system", content: "never upload" } as any), undefined);
  assert.equal(mirrorMessage({ role: "custom", content: "never upload" } as any), undefined);
});

test("inbound text rejects tool results, malformed content, and unsupported attachments", () => {
  assert.equal(inboundText({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }), "hi");
  for (const payload of [
    { type: "user", message: { content: [{ type: "tool_result", content: "rm -rf" }] } },
    { type: "user", message: { content: [{ type: "text", text: "hi" }, { type: "image" }] } },
    { type: "user", message: null }, { type: "user", message: { content: [null] } },
  ]) assert.equal(inboundText(payload), undefined);
});

test("dedup memory is bounded", () => {
  const ids = new RecentIds();
  for (let i = 0; i < 1100; i++) ids.add(String(i));
  assert.equal(ids.has("0"), false);
  assert.equal(ids.has("1099"), true);
});

test("connect resolves while SSE stays open; correct OAuth/worker auth, batching and ordering", async (t) => {
  const h = harness();
  t.after(() => h.bridge.stop());
  h.bridge.send({ type: "user", message: { role: "user", content: "queued during startup" } });
  await h.bridge.start();
  assert.deepEqual(h.connected, ["cse_example"]);
  h.bridge.send({ type: "assistant", message: { content: "answer" } });
  h.bridge.reportState("idle");
  await until(() => h.events().length === 2 && h.requests.at(-1)?.body?.worker_status === "idle");
  assert.deepEqual(h.events().map((event) => event.type), ["user", "assistant"]);
  assert.ok(h.events().every((event) => event.uuid && event.session_id === "cse_example"));
  const create = h.requests[0];
  assert.deepEqual(create.body, { title: "pi: test", bridge: {}, tags: ["pi-plus"] });
  assert.equal((create.init.headers as any).Authorization, "Bearer oauth-secret");
  assert.equal((h.requests[1].init.headers as any)["X-Trusted-Device-Token"], "device-secret");
  for (const request of h.requests.filter((item) => item.url.startsWith("https://worker.example"))) {
    assert.equal((request.init.headers as any).Authorization, "Bearer worker-secret");
    assert.equal((request.init.headers as any)["X-Trusted-Device-Token"], undefined);
    if (request.body) assert.equal(request.body.worker_epoch, 1);
  }
  assert.ok(h.requests.every((request) => !request.url.includes("/messages")));
});

test("inbound dedup, outbound echoes, control replies, and stop forwarding", async (t) => {
  const h = harness();
  t.after(() => h.bridge.stop());
  await h.bridge.start();
  h.bridge.send({ type: "user", message: { role: "user", content: "local" } });
  await until(() => h.events().length === 1);
  h.push(h.events()[0], "echo");
  h.push({ type: "user", uuid: "in-1", message: { content: "remote" } }, "in-1", 2);
  h.push({ type: "user", uuid: "in-1", message: { content: "remote" } }, "in-replay", 3);
  h.push({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }, "init", 4);
  h.push({ type: "control_request", request_id: "stop", request: { subtype: "interrupt" } }, "stop", 5);
  h.push({ type: "control_request", request_id: "permission", request: { subtype: "can_use_tool" } }, "permission", 6);
  h.push({ type: "control_request", request_id: "model", request: { subtype: "set_model", model: "x" } }, "model", 7);
  await until(() => h.events().filter((event) => event.type === "control_response").length === 4);
  assert.deepEqual(h.texts, ["remote"]);
  assert.equal(h.interrupts, 1);
  const replies = h.events().filter((event) => event.type === "control_response").map((event) => event.response);
  assert.equal(replies.find((reply) => reply.request_id === "permission").response.behavior, "deny");
  assert.equal(replies.find((reply) => reply.request_id === "model").subtype, "error");
  assert.ok(h.requests.some((request) => request.body?.updates?.[0].event_id === "in-replay"));
});

test("read-only prevents both remote messages and interrupt", async (t) => {
  const h = harness({ allowInbound: false });
  t.after(() => h.bridge.stop());
  await h.bridge.start();
  h.push({ type: "user", message: { content: "ignored" } });
  h.push({ type: "control_request", request_id: "stop", request: { subtype: "interrupt" } }, "stop");
  await until(() => h.events().length > 0);
  assert.deepEqual(h.texts, []);
  assert.equal(h.interrupts, 0);
  assert.equal(h.events()[0].response.subtype, "error");
});

test("stop during OAuth startup cannot resurrect a connection", async () => {
  let resolve!: (token: string) => void;
  const h = harness({ getAccessToken: () => new Promise((done) => { resolve = done; }) });
  const start = h.bridge.start();
  h.bridge.stop();
  resolve("secret");
  await start;
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.connected, []);
});

test("permanent write failure stops retries and never exposes server bodies or credentials", async (t) => {
  const h = harness();
  t.after(() => h.bridge.stop());
  h.handle((url) => url.endsWith("/events") ? new Response("oauth-secret device-secret", { status: 403 }) : undefined);
  await h.bridge.start();
  h.bridge.send({ type: "assistant", message: { content: "hi" } });
  await until(() => h.errors.length === 1);
  assert.deepEqual(h.errors, ["Claude Remote HTTP 403"]);
  assert.equal(h.bridge.closed, true);
  assert.equal(h.requests.filter((request) => request.url.endsWith("/events")).length, 1);
});

test("bounded messages and startup queue fail closed rather than consuming unbounded memory", () => {
  const large = harness();
  large.bridge.send({ type: "user", content: "x".repeat(4 * 1024 * 1024) });
  assert.equal(large.bridge.closed, true);
  assert.match(large.errors[0], /4 MiB/);
  const full = harness();
  for (let i = 0; i < 513; i++) full.bridge.send({ type: "user", content: "x" });
  assert.equal(full.bridge.closed, true);
  assert.equal(full.errors.length, 1);
  assert.match(full.errors[0], /queue is full/);
});

test("worker refresh fetches a fresh OAuth token, rotates epoch and transport, and reschedules", async (t) => {
  let authCalls = 0;
  let epoch = 0;
  const h = harness({ getAccessToken: async () => `oauth-${++authCalls}` });
  t.after(() => h.bridge.stop());
  h.handle((url) => url.endsWith("/bridge") ? Response.json({
    worker_jwt: `worker-${++epoch}`, api_base_url: "https://worker.example", expires_in: 1.5, worker_epoch: epoch,
  }) : undefined);
  await h.bridge.start();
  await until(() => epoch >= 2 && h.streams.length >= 2);
  assert.equal(authCalls, 2);
  h.bridge.send({ type: "assistant", message: { content: "after refresh" } });
  await until(() => h.events().length === 1);
  const write = h.requests.find((request) => request.url.endsWith("/events"))!;
  assert.equal(write.body.worker_epoch, 2);
  assert.equal((write.init.headers as any).Authorization, "Bearer worker-2");
  assert.deepEqual(h.errors, []);
  // Verify the second refresh wasn't lost by a scheduler overwriting its timer.
  await until(() => epoch >= 3);
});

test("SSE reconnect uses processed sequence cursor and does not duplicate inbound prompts", async (t) => {
  const connections: boolean[] = [];
  const h = harness({ onConnectionChange: (connected) => connections.push(connected) });
  t.after(() => h.bridge.stop());
  await h.bridge.start();
  const payload = { type: "user", uuid: "once", message: { content: "hello" } };
  h.push(payload, "first", 42);
  await until(() => h.texts.length === 1);
  h.streams[0].close();
  await until(() => connections.at(-1) === false);
  await until(() => h.streams.length === 2 && connections.at(-1) === true);
  assert.deepEqual(connections, [false, true, false, true]);
  const reconnect = h.requests.filter((request) => request.url.includes("/events/stream")).at(-1)!;
  assert.match(reconnect.url, /from_sequence_num=42/);
  assert.equal((reconnect.init.headers as any)["Last-Event-ID"], "42");
  h.push(payload, "replay", 42);
  await until(() => h.requests.some((request) => request.body?.updates?.[0].event_id === "replay"));
  assert.deepEqual(h.texts, ["hello"]);
});
