import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../../src/domains/workflows/runtime/agent-runner.ts";
import { sendAgentInput } from "../../src/domains/workflows/runtime/live-agent.ts";
import { ProgressTracker } from "../../src/domains/workflows/runtime/progress.ts";
import { Semaphore } from "../../src/domains/workflows/runtime/concurrency.ts";
import { WorkflowAgentLimiter } from "../../src/domains/workflows/runtime/agent-limits.ts";
import { createPerfRecorder } from "../../src/domains/workflows/runtime/perf.ts";
import { hostWorkflowModelProfiles } from "../../src/domains/workflows/runtime/model-profiles.ts";
import workflowExtension from "../../src/domains/workflows/index.ts";
import { WorkflowLifecycle } from "../../src/domains/workflows/runtime/workflow-lifecycle.ts";
import { resolveWorkflowRunOptions } from "../../src/domains/workflows/runtime/options.ts";

const model = { provider: "test", id: "model", name: "Test Model" } as any;
const options = { label: "Selected", model: "test/model", thinkingLevel: "high", resume: "off", tools: [] } as const;
const resumeBase = { workflow: { kind: "unverifiable", reason: "test" } } as any;
function makeProgress() {
  return new ProgressTracker({ hasUI: true, ui: { theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s }, setWidget() {}, setStatus() {} } } as any, "test", "run");
}
function context(progress: ProgressTracker, semaphore: Semaphore, createSession = async () => { throw new Error("Unexpected session"); }) {
  return {
    cwd: process.cwd(), modelRegistry: { find: () => model }, hostModel: model,
    modelProfiles: hostWorkflowModelProfiles(model), progress, semaphore,
    agentLimiter: new WorkflowAgentLimiter(null), agentTimeoutMs: null, agentRetries: 0,
    budget: { total: null, spent: () => 0, remaining: () => null },
    perf: createPerfRecorder(false), createSession,
    usage: { recordAgentSession() {} },
  } as any;
}

test("runAgent binds cancellation before semaphore admission", async () => {
  const progress = makeProgress();
  const semaphore = new Semaphore(1);
  let release!: () => void;
  const blocker = semaphore.run(() => new Promise<void>((resolve) => { release = resolve; }));
  try {
    const pending = runAgent(context(progress, semaphore), "Task", options, resumeBase);
    const rejection = assert.rejects(pending, /stopped by user/);
    progress.stopAgent(1);
    await rejection;
    assert.equal(progress.snapshot().phases[0].agents[0].status, "stopped");
    release(); await blocker;
    assert.equal(await semaphore.run(async () => "available"), "available");
  } finally { release(); progress.done(); }
});

test("running stop aborts and disposes only that child session", async () => {
  const progress = makeProgress();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let aborts = 0, disposed = 0;
  const child = {
    model, thinkingLevel: "high", messages: [], systemPrompt: "", isStreaming: true,
    prompt: () => { ready(); return new Promise<void>(() => {}); },
    abort: async () => { aborts++; }, dispose: () => { disposed++; },
    subscribe: () => () => {}, setAutoRetryEnabled() {}, getActiveToolNames: () => [],
    getAllTools: () => [], getToolDefinition: () => undefined, setActiveToolsByName() {},
    followUp: async () => {}, getLastAssistantText: () => "",
  } as any;
  try {
    const rc = context(progress, new Semaphore(1), async () => ({ session: child }) as any);
    const pending = runAgent(rc, "Task", options, resumeBase);
    const rejection = assert.rejects(pending, /stopped by user/);
    await started;
    progress.stopAgent(1);
    await rejection;
    assert.equal(aborts, 1);
    assert.equal(disposed, 1);
    assert.equal(progress.snapshot().phases[0].agents[0].status, "stopped");
  } finally { progress.done(); }
});

test("SDK commands and native queues target the child only", async () => {
  const selected: unknown[] = [], levels: string[] = [], steering: string[] = [], followUps: string[] = [];
  const child = {
    isStreaming: true, setModel: async (value: unknown) => { selected.push(value); },
    setThinkingLevel: (level: string) => { levels.push(level); },
    steer: async (text: string) => { steering.push(text); }, followUp: async (text: string) => { followUps.push(text); },
  } as any;
  const rc = { modelRegistry: { find: () => model }, hostModel: undefined } as any;
  await sendAgentInput(child, rc, "/model test/model");
  await sendAgentInput(child, rc, "/thinking high");
  await sendAgentInput(child, rc, "Steering text", true);
  await sendAgentInput(child, rc, "Follow-up text", false);
  await assert.rejects(sendAgentInput(child, rc, "/unknown"), /Supported agent commands/);
  assert.deepEqual(selected, [model]);
  assert.deepEqual(levels, ["high"]);
  assert.deepEqual(steering, ["Steering text"]);
  assert.deepEqual(followUps, ["Follow-up text"]);
});

test("one workflow lifecycle accepts immediate completion and deduplicates durable delivery", async () => {
  const records = new Map<string, any>();
  const entries: any[] = [];
  const store = { load: async (id: string) => records.get(id), save: async (record: any) => { records.set(record.runId, record); }, list: async () => [...records.values()] };
  const lifecycle = new WorkflowLifecycle({ sendMessage: (message: any) => { entries.push({ type: "message", message: { ...message, role: "custom" } }); } } as any, { storeForCwd: () => store as any });
  const ctx = { cwd: process.cwd(), mode: "rpc", hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => "owner", getEntries: () => entries } } as any;
  const launched = await lifecycle.launch({ ctx, name: "instant", options: resolveWorkflowRunOptions({}),
    async execute(_ctx, runOptions) {
      const record = { runId: runOptions.runId, state: "completed", workflow: { name: "instant" }, options: {},
        result: { kind: "available", value: "done" }, updatedAt: Date.now(), endedAt: Date.now(),
        background: { origin: runOptions.origin, delivery: { state: "pending" } } };
      records.set(runOptions.runId!, record);
      await runOptions.onRunMetadata?.({ runId: runOptions.runId!, journalPath: "test", recordPath: "test" });
    },
  });
  assert.equal(launched.details.error, undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(entries.length, 1);
  assert.equal(records.get(launched.details.runId as string).background.delivery.state, "delivered");
  // Simulate an old record whose delivery write was lost after the message was appended.
  const record = records.get(launched.details.runId as string);
  record.background.delivery = { state: "pending" };
  await lifecycle.durableRunSettled(ctx, record.runId);
  assert.equal(entries.length, 1);
});

test("workflow tool is background-only and management does not require a script", async () => {
  let tool: any;
  const pi = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (value: any) => { tool = value; } : () => {} });
  workflowExtension(pi as any);
  assert.equal(tool.name, "workflow");
  assert.equal(tool.parameters.properties.background, undefined);
  for (const key of ["action", "runId", "agentId"]) assert.ok(tool.parameters.properties[key]);
  const ctx = { cwd: process.cwd(), mode: "print", hasUI: false, sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined } } as any;
  const result = await tool.execute("call", { name: "code-review" }, undefined, undefined, ctx);
  assert.equal(result.details.error, "workflow_unavailable");
  const inspected = await tool.execute("call", { action: "inspect" }, undefined, undefined, ctx);
  assert.match(inspected.details.error, /runId is required/);
});
