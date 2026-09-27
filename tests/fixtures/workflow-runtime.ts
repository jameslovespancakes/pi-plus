import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../../src/domains/workflows/agents/agent-runner.ts";
import { sendAgentInput } from "../../src/domains/workflows/agents/live-agent.ts";
import { ProgressTracker } from "../../src/domains/workflows/runs/progress.ts";
import { Semaphore } from "../../src/domains/workflows/execution/concurrency.ts";
import { WorkflowAgentLimiter } from "../../src/domains/workflows/execution/agent-limits.ts";
import { createPerfRecorder } from "../../src/domains/workflows/execution/perf.ts";
import { hostWorkflowModelProfiles } from "../../src/domains/workflows/definitions/model-profiles.ts";
import workflowExtension, { parseWorkflowInvocation } from "../../src/domains/workflows/index.ts";
import { WorkflowLifecycle } from "../../src/domains/workflows/runs/workflow-lifecycle.ts";
import { resolveWorkflowRunOptions } from "../../src/domains/workflows/definitions/options.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResolvedWorkflow } from "../../src/domains/workflows/execution/engine.ts";
import { WorkflowAbortError, WorkflowPauseError } from "../../src/domains/workflows/execution/cancellation.ts";
import { manageWorkflow } from "../../src/domains/workflows/runs/workflow-management.ts";
import { ProjectWorkflowRunStore } from "../../src/domains/workflows/runs/workflow-run-store.ts";
import { createWorkflowRunRecord, transitionWorkflowRun } from "../../src/domains/workflows/runs/workflow-run-record.ts";

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
    agentLimiter: new WorkflowAgentLimiter(null), agentTimeoutMs: null,
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
  const lifecycle = new WorkflowLifecycle({
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
    sendMessage: (message: any) => { entries.push({ type: "custom_message", ...message }); },
  } as any, { storeForCwd: () => store as any });
  const ctx = { cwd: process.cwd(), mode: "rpc", hasUI: false, isIdle: () => true,
    sessionManager: { getSessionId: () => "owner", getBranch: () => entries } } as any;
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
  assert.equal(entries.length, 2);
  assert.equal(records.get(launched.details.runId as string).background.delivery.state, "delivered");
  // Simulate an old record whose delivery write was lost after the message was appended.
  const record = records.get(launched.details.runId as string);
  record.background.delivery = { state: "pending" };
  await lifecycle.durableRunSettled(ctx, record.runId);
  assert.equal(entries.length, 2);
});

test("workflow tool is background-only and management does not require a script", async () => {
  let tool: any;
  const pi = new Proxy({}, { get: (_target, key) => key === "registerTool" ? (value: any) => { tool = value; } : () => {} });
  workflowExtension(pi as any);
  assert.equal(tool.name, "workflow");
  assert.equal(tool.parameters.properties.background, undefined);
  assert.equal(tool.parameters.properties.agentRetries, undefined);
  assert.match(parseWorkflowInvocation("code-review --agent-retries=2").optionErrors?.join(" ") ?? "", /retries are automatic/);
  for (const key of ["action", "runId", "agentId"]) assert.ok(tool.parameters.properties[key]);
  const ctx = { cwd: process.cwd(), mode: "print", hasUI: false, sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined } } as any;
  const result = await tool.execute("call", { name: "code-review" }, undefined, undefined, ctx);
  assert.equal(result.details.error, "workflow_unavailable");
  const inspected = await tool.execute("call", { action: "inspect" }, undefined, undefined, ctx);
  assert.match(inspected.details.error, /runId is required/);
});

test("status checks expose only running agents and the last ten actual transcript entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-status-"));
  const previous = process.env.PI_WORKFLOW_RUNS_DIR;
  process.env.PI_WORKFLOW_RUNS_DIR = dir;
  const progress = makeProgress();
  try {
    const running = progress.agentQueued(undefined, "Active", "p/model");
    progress.agentStart(undefined, "Active", running);
    const completed = progress.agentQueued(undefined, "Finished private row");
    progress.agentDone("Finished private row", completed);
    progress.agentMessage(running, "assistant", "breadcrumb, not the native transcript");
    const native: any[] = Array.from({ length: 30 }, (_, index) => ({ role: "toolResult", toolCallId: `call-${index}`,
      toolName: "read", content: [{ type: "text", text: `actual-output-${index}` }], timestamp: index, isError: false }));
    native.push({ role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }], timestamp: 31 });
    const source = { snapshot: () => progress.snapshot(), conversation: (id: number) => progress.conversation(id),
      transcript: () => ({ messages: native, steering: ["private queued prompt"], followUp: [] }) } as any;
    const store = new ProjectWorkflowRunStore(dir);
    let record = createWorkflowRunRecord({ runId: "run", progress: progress.snapshot(),
      workflow: { meta: { name: "status-test", description: "Fixture" }, source: { kind: "unverifiable", reason: "fixture" }, default: async () => {} } as any,
      options: resolveWorkflowRunOptions({ origin: { sessionId: "owner", requestedAt: Date.now() } }) });
    record = transitionWorkflowRun(record, { state: "running", progress: progress.snapshot() });
    await store.save(record);
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "owner" } } as any;
    const coordinator = { activeRunIds: () => new Set(["run"]) } as any;
    const sources = new Map([["run", { source }]]);
    const list = await manageWorkflow({ action: "list" }, ctx, coordinator, sources);
    assert.equal(list.details.runs[0].agents.length, 1);
    assert.equal(list.details.runs[0].agents[0].id, running);
    assert.doesNotMatch(list.content[0].text, /Finished private|actual-output|breadcrumb/);
    const inspected = await manageWorkflow({ action: "inspect", runId: "run", agentId: running }, ctx, coordinator, sources);
    assert.equal(inspected.details.untrustedActivity.length, 10);
    assert.match(inspected.details.untrustedActivity[0].text, /actual-output-20/);
    assert.match(inspected.details.untrustedActivity[9].text, /actual-output-29/);
    assert.deepEqual(inspected.details.queued, { steering: 1, followUp: 0 });
    assert.doesNotMatch(inspected.content[0].text, /private reasoning|private queued prompt|breadcrumb|actual-output-19/);
    const whole = await manageWorkflow({ action: "inspect", runId: "run" }, ctx, coordinator, sources);
    assert.equal(whole.details.untrustedActivity.length, 10);
    assert.equal(whole.details.agents.length, 1);
    const finished = await manageWorkflow({ action: "inspect", runId: "run", agentId: completed }, ctx, coordinator, sources);
    assert.equal(finished.details.untrustedActivity, undefined);
    native.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "\\\"".repeat(100_000) }], timestamp: 32 });
    const bounded = await manageWorkflow({ action: "inspect", runId: "run" }, ctx, coordinator, sources);
    assert.ok(JSON.stringify(bounded.details).length < 6_000);
    assert.deepEqual(JSON.parse(bounded.content[0].text), bounded.details, "both surfaces retain valid bounded JSON");
    const foreign = await manageWorkflow({ action: "inspect", runId: "run" }, { ...ctx, sessionManager: { getSessionId: () => "foreign" } }, coordinator, sources);
    assert.match(foreign.details.error, /not found in this session/);
    progress.done();
    const ended = await manageWorkflow({ action: "list" }, ctx, coordinator, sources);
    assert.deepEqual(ended.details.runs[0].agents, [], "terminal progress cannot claim an agent is running");
  } finally {
    progress.done();
    if (previous === undefined) delete process.env.PI_WORKFLOW_RUNS_DIR; else process.env.PI_WORKFLOW_RUNS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engine clears live widgets before cleanup on success, failure, pause, and stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-cleanup-"));
  const previous = process.env.PI_WORKFLOW_RUNS_DIR;
  process.env.PI_WORKFLOW_RUNS_DIR = dir;
  try {
    for (const outcome of ["success", "failure", "pause", "stop"]) {
      const widgets: unknown[] = [];
      let source: any;
      let cleaned = false;
      const controller = new AbortController();
      const clearCheck = async () => {
        assert.equal(widgets.at(-1), undefined, `${outcome}: widget cleared before worktree cleanup`);
        cleaned = true;
      };
      const ctx = { cwd: dir, hasUI: true, model, modelRegistry: {}, signal: controller.signal,
        ui: { theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s }, setWidget: (_key: string, lines: unknown) => widgets.push(lines) },
      } as any;
      const mod = { meta: { name: "cleanup-test", description: "Fixture" }, source: { kind: "unverifiable", reason: "fixture" },
        default: async (api: any) => {
          api.phase("Working");
          if (outcome === "failure") throw new Error("workflow failed");
          if (outcome === "pause") throw new WorkflowPauseError();
          if (outcome === "stop") { controller.abort(new WorkflowAbortError("Stopped")); throw controller.signal.reason; }
          return "done";
        },
      } as any;
      const runOptions = resolveWorkflowRunOptions({
        onProgressSource(value) { if (value) source = value; },
        onProgressSnapshot() { throw new Error("late observer failed"); },
      });
      const execution = runResolvedWorkflow(ctx, mod, "", runOptions, {
        modelProfiles: hostWorkflowModelProfiles(model),
        worktrees: { preservedPaths: [], preserveRecoverable() {}, removeAll: clearCheck, removeUnpreserved: clearCheck } as any,
      });
      if (outcome === "success") assert.equal(await execution, "done");
      else await assert.rejects(execution);
      assert.equal(cleaned, true);
      assert.ok(source.snapshot().doneAt);
      const firstClear = widgets.indexOf(undefined);
      assert.ok(firstClear >= 0);
      assert.ok(widgets.slice(firstClear).every((lines) => lines === undefined), `${outcome}: late finalizer warning did not recreate widget`);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WORKFLOW_RUNS_DIR;
    else process.env.PI_WORKFLOW_RUNS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
