import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkflowLifecycle } from "../../src/domains/workflows/runs/workflow-lifecycle.ts";
import { resolveWorkflowRunOptions } from "../../src/domains/workflows/definitions/options.ts";
import { model, message, response } from "./provider-stream.ts";

function harness() {
  const sessionManager = SessionManager.inMemory();
  const records = new Map<string, any>();
  let idle = false;
  let appendMessages = true;
  const sent: any[] = [];
  const store = { load: async (id: string) => records.get(id), save: async (value: any) => { records.set(value.runId, value); }, list: async () => [...records.values()] };
  const ctx = { cwd: process.cwd(), mode: "rpc", hasUI: false, isIdle: () => idle, sessionManager } as any;
  const pi = {
    appendEntry: (customType: string, data: unknown) => sessionManager.appendCustomEntry(customType, data),
    sendMessage: (notification: any, options: any) => {
      sent.push({ message: notification, options });
      if (appendMessages) sessionManager.appendCustomMessageEntry(notification.customType, notification.content, notification.display, notification.details);
    },
  };
  const create = () => new WorkflowLifecycle(pi, { storeForCwd: () => store as any });
  function record(runId = "test-run", sessionId = sessionManager.getSessionId()) {
    const value = { runId, state: "completed", workflow: { name: "trace-launch-2" }, options: {},
      result: { kind: "value", value: "Found the startup failure." }, updatedAt: Date.now(), endedAt: Date.now(),
      background: { origin: { sessionId, requestedAt: 1 }, delivery: { state: "pending" } } };
    records.set(runId, value);
    return value;
  }
  const boundary = (lifecycle: WorkflowLifecycle, outcome = "completed", entries: any[] = []) =>
    lifecycle.beforeBoundary(ctx, { outcome, entries, continue: false } as any);
  function commit(result: any) {
    for (const entry of result?.entries ?? []) {
      if (entry.type === "custom_message") sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
      else if (entry.type === "custom") sessionManager.appendCustomEntry(entry.customType, entry.data);
    }
  }
  const receipts = () => sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "workflow-result");
  const notifications = () => sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "workflow-result");
  return { ctx, pi, records, store, sent, create, record, boundary, commit, receipts, notifications,
    setIdle: (value: boolean) => { idle = value; }, setAppendMessages: (value: boolean) => { appendMessages = value; } };
}

test("busy completion renders immediately, then notifies once at a native boundary", async () => {
  const h = harness(), lifecycle = h.create();
  h.record();
  await lifecycle.durableRunSettled(h.ctx, "test-run");
  assert.equal(h.receipts().length, 1);
  assert.equal(h.notifications().length, 0);
  assert.equal(h.sent.length, 0);
  const previous = { type: "custom", customType: "other-extension", data: {} };
  const draft = await h.boundary(lifecycle, "completed", [previous]);
  assert.equal(draft?.continue, true);
  assert.equal(draft?.entries?.[0], previous);
  assert.equal(h.records.get("test-run").background.delivery.state, "pending");
  h.commit(draft);
  assert.equal(h.notifications()[0].display, false);
  assert.match(h.notifications()[0].content as string, /untrusted data/);
  assert.equal(await h.boundary(lifecycle), undefined);
  assert.equal(h.records.get("test-run").background.delivery.state, "delivered");
  await lifecycle.durableRunSettled(h.ctx, "test-run");
  assert.equal(h.receipts().length, 1);
  assert.equal(h.notifications().length, 1);
});

test("idle completion wakes the parent once, including concurrent delivery attempts", async () => {
  const h = harness(), lifecycle = h.create();
  h.setIdle(true); h.record();
  await Promise.all(Array.from({ length: 4 }, () => lifecycle.durableRunSettled(h.ctx, "test-run")));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true);
  assert.equal(h.sent[0].message.display, false);
  assert.equal(h.receipts().length, 1);
  assert.equal(h.records.get("test-run").background.delivery.state, "delivered");
});

test("cancelled and failed parent turns receive context without automatic continuation", async () => {
  for (const outcome of ["aborted", "error"]) {
    const h = harness(), lifecycle = h.create(); h.record();
    await lifecycle.durableRunSettled(h.ctx, "test-run");
    const draft = await h.boundary(lifecycle, outcome);
    assert.equal(draft?.continue, false);
    h.commit(draft);
    h.setIdle(true);
    await lifecycle.agentSettled(h.ctx);
    assert.equal(h.sent.length, 0);
    h.record("later");
    await lifecycle.durableRunSettled(h.ctx, "later");
    assert.equal(h.sent.at(-1).options.triggerTurn, false);
    lifecycle.agentStarted(h.ctx);
    h.record("new-turn");
    await lifecycle.durableRunSettled(h.ctx, "new-turn");
    assert.equal(h.sent.at(-1).options.triggerTurn, true);
  }
});

test("reload recovers an uncommitted notification without duplicating its visible receipt", async () => {
  const h = harness(); h.record();
  const first = h.create();
  await first.durableRunSettled(h.ctx, "test-run");
  await h.boundary(first); // Simulate process exit before pi commits the returned drafts.
  h.setIdle(true);
  await h.create().sessionStarted(h.ctx);
  assert.equal(h.receipts().length, 1);
  assert.equal(h.notifications().length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.records.get("test-run").background.delivery.state, "delivered");
});

test("a queued idle wakeup is not acknowledged until pi persists the message", async () => {
  const h = harness(), lifecycle = h.create(); h.record(); h.setIdle(true); h.setAppendMessages(false);
  await lifecycle.durableRunSettled(h.ctx, "test-run");
  await lifecycle.durableRunSettled(h.ctx, "test-run");
  assert.equal(h.sent.length, 1);
  assert.equal(h.records.get("test-run").background.delivery.state, "pending");
  h.commit({ entries: [{ type: "custom_message", ...h.sent[0].message }] });
  await lifecycle.agentSettled(h.ctx);
  assert.equal(h.records.get("test-run").background.delivery.state, "delivered");
});

test("legacy visible messages count as both receipts and notifications", async () => {
  const h = harness(); h.record(); h.setIdle(true);
  h.ctx.sessionManager.appendCustomMessageEntry("workflow-result", "old result", true, { runId: "test-run" });
  await h.create().durableRunSettled(h.ctx, "test-run");
  assert.equal(h.receipts().length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.records.get("test-run").background.delivery.state, "delivered");
});

test("delivery stays in its originating session and never publishes unfinished runs", async () => {
  const h = harness(), lifecycle = h.create(); h.setIdle(true);
  h.record("foreign", "another-session");
  h.record("running").state = "running";
  await lifecycle.durableRunSettled(h.ctx, "foreign");
  await lifecycle.durableRunSettled(h.ctx, "running");
  assert.equal(h.receipts().length, 0);
  assert.equal(h.sent.length, 0);
});

test("interactive follow-ups share run tracking and safe delivery while retaining full UI output", async () => {
  const h = harness(), lifecycle = h.create();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let id = "";
  const value = { summary: "Preview ready", patch: "PRIVATE_PATCH_BODY".repeat(100) };
  const pending = lifecycle.runToCompletion({
    ctx: h.ctx, name: "review-fix", options: resolveWorkflowRunOptions({}),
    execute: async (_ctx, options) => {
      id = options.runId!;
      const record = h.record(id);
      record.state = "running";
      options.onRunMetadata?.({ runId: id } as any);
      await gate;
      record.state = "completed";
      record.result = { kind: "value", value };
      return value;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lifecycle.activeRunIds(h.ctx).has(id));
  finish();
  assert.equal(await pending, value);
  await lifecycle.durableRunSettled(h.ctx, id);
  assert.equal(h.receipts().length, 1);
  assert.deepEqual((h.receipts()[0] as any).data.result, value);
  assert.equal(h.notifications().length, 0);
  const boundary = await h.boundary(lifecycle);
  assert.ok(boundary);
  assert.doesNotMatch(JSON.stringify(boundary), /PRIVATE_PATCH_BODY/);
  h.commit(boundary);
  await lifecycle.durableRunSettled(h.ctx, id);
  assert.equal(h.notifications().length, 1);
  assert.equal(h.receipts().length, 1);
});

test("interactive follow-ups use the same stop handle and preserve errors", async () => {
  const h = harness(), lifecycle = h.create();
  let id = "";
  const pending = lifecycle.runToCompletion({
    ctx: h.ctx, name: "review-fix", options: resolveWorkflowRunOptions({}),
    execute: async (ctx, options) => {
      id = options.runId!;
      const record = h.record(id);
      record.state = "running";
      options.onRunMetadata?.({ runId: id } as any);
      try {
        await new Promise<void>((_resolve, reject) => ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }));
      } finally {
        record.state = "stopped";
        record.message = "Stopped by user";
      }
    },
  });
  const rejected = assert.rejects(pending, /stopped by user/i);
  await new Promise((resolve) => setImmediate(resolve));
  await lifecycle.stop(h.ctx, id);
  await rejected;
  assert.equal(lifecycle.activeRunIds(h.ctx).size, 0);
  assert.equal(h.receipts().length, 1);
  await assert.rejects(lifecycle.runToCompletion({
    ctx: h.ctx, name: "broken", options: resolveWorkflowRunOptions({}),
    execute: async () => { throw new Error("setup failed"); },
  }), /setup failed/);
});

test("native SDK completion preserves tool batches and reaches the next provider request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-delivery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = harness();
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let lifecycle!: WorkflowLifecycle, ctx: any;
  let toolsRun = 0;
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture-key", models: [model] });
      lifecycle = new WorkflowLifecycle(pi, { storeForCwd: () => h.store as any });
      pi.on("session_start", (_event, context) => { ctx = context; h.record("test-run", context.sessionManager.getSessionId()); });
      pi.on("agent_start", (_event, context) => lifecycle.agentStarted(context));
      pi.on("turn_end", (event, context) => lifecycle.beforeBoundary(context, event));
      pi.on("agent_before_settle", (event, context) => lifecycle.beforeBoundary(context, event));
      pi.on("agent_settled", (_event, context) => lifecycle.agentSettled(context));
      pi.registerTool({ name: "finish_workflow", label: "Finish", description: "Fixture", parameters: Type.Object({}),
        execute: async () => { toolsRun++; await lifecycle.durableRunSettled(ctx, "test-run"); return { content: [{ type: "text", text: "finished" }], details: undefined }; } });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["finish_workflow"] });
  t.after(() => session.dispose());
  const errors: unknown[] = [], events: any[] = [], requests: any[] = [];
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
  session.setActiveToolsByName(["finish_workflow"]);
  assert.ok(session.getActiveToolNames().includes("finish_workflow"), JSON.stringify(session.getAllTools()));
  session.agent.streamFunction = (_model, context) => {
    requests.push(context.messages.slice());
    return response(requests.length === 1 ? message(undefined, { stopReason: "toolUse", content: [
      { type: "toolCall", id: "first", name: "finish_workflow", arguments: {} },
      { type: "toolCall", id: "second", name: "finish_workflow", arguments: {} },
    ] }) : message());
  };
  await session.prompt("Run both fixture tools.");
  assert.deepEqual(errors, []);
  assert.equal(toolsRun, 2, JSON.stringify({ requests: requests.length, messages: session.messages }));
  assert.equal(requests.length, 2);
  const next = requests[1];
  const toolResults = next.filter((entry: any) => entry.role === "toolResult");
  assert.equal(toolResults.length, 2);
  const notificationIndex = next.findIndex((entry: any) => JSON.stringify(entry).includes("Found the startup failure."));
  assert.ok(notificationIndex > next.findLastIndex((entry: any) => entry.role === "toolResult"));
  const receiptEvents = events.filter((event) => event.type === "entry_appended" && event.entry.type === "custom" && event.entry.customType === "workflow-result");
  assert.equal(receiptEvents.length, 1);
  assert.equal(h.records.get("test-run").background.delivery.state, "delivered");
  assert.equal(events.filter((event) => event.type === "entry_appended" && event.entry.type === "custom_message").length, 1);
  // A later result wakes an idle native session, without another user prompt or duplicate turn.
  h.record("idle-result", ctx.sessionManager.getSessionId());
  await lifecycle.durableRunSettled(ctx, "idle-result");
  await session.waitForIdle();
  assert.equal(requests.length, 3);
  assert.equal(h.records.get("idle-result").background.delivery.state, "delivered");
  assert.deepEqual(errors, []);

  // Completion during an in-flight request is visible immediately; cancelling the parent must not wake it again.
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  session.agent.streamFunction = (_model, context, options) => {
    requests.push(context.messages.slice());
    if (requests.length > 4) return response(message());
    const stream = createAssistantMessageEventStream();
    options?.signal?.addEventListener("abort", () => {
      stream.push({ type: "error", reason: "aborted", error: message("Aborted", { stopReason: "aborted" }) });
      stream.end();
    }, { once: true });
    ready();
    return stream;
  };
  const pending = session.prompt("Wait for cancellation.");
  await started;
  h.record("cancelled-parent", ctx.sessionManager.getSessionId());
  await lifecycle.durableRunSettled(ctx, "cancelled-parent");
  assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.type === "custom" && event.entry.data?.runId === "cancelled-parent"));
  assert.equal(h.records.get("cancelled-parent").background.delivery.state, "pending");
  await session.abort();
  await pending;
  await session.waitForIdle();
  assert.equal(requests.length, 4, "a cancelled parent must not be restarted by pending results");
  assert.equal(h.records.get("cancelled-parent").background.delivery.state, "delivered");
  assert.deepEqual(errors, []);
});
