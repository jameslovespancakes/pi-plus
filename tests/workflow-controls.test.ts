import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { assertAgentOptions } from "../src/domains/workflows/runtime/agent-options.ts";
import { ProgressTracker } from "../src/domains/workflows/runtime/progress.ts";
import { WorkflowInspector } from "../src/domains/workflows/runtime/ui/workflow-inspector.ts";
import { AgentTranscriptView } from "../src/domains/workflows/runtime/ui/agent-transcript.ts";
import { thinkingLabel } from "../src/domains/workflows/runtime/ui/workflow-widget.ts";
import { Semaphore, parallel } from "../src/domains/workflows/runtime/concurrency.ts";
import { WorkflowAgentStoppedError } from "../src/domains/workflows/runtime/cancellation.ts";

const theme = {
  fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text,
  strikethrough: (text: string) => text, underline: (text: string) => text,
} as any;
function tracker() {
  return new ProgressTracker({ hasUI: true, ui: { theme, setWidget() {}, setStatus() {} } } as any, "Review", "test-run");
}

test("agent configuration rejects missing fields and profile-only routing before launch", () => {
  const valid = { label: "Security", model: "provider/model", thinkingLevel: "high" };
  assert.doesNotThrow(() => assertAgentOptions(valid));
  for (const field of ["label", "model", "thinkingLevel"]) {
    const missing = { ...valid };
    delete missing[field];
    assert.throws(() => assertAgentOptions(missing), /explicit label, model, and thinkingLevel/);
  }
  for (const invalid of [undefined, {}, { label: "  ", model: "a", thinkingLevel: "off" }, { ...valid, thinkingLevel: "auto" }, { label: "A", profile: "medium" }]) {
    assert.throws(() => assertAgentOptions(invalid));
  }
  assert.deepEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(thinkingLabel), ["Off", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
});

test("Esc navigates back, X stops only from the list, and narrow terminals disable inspection", async () => {
  const progress = tracker();
  const first = progress.agentQueued(undefined, "First", "p/a", "Model A", "high");
  const second = progress.agentQueued(undefined, "Second", "p/b", "Model B", "off");
  progress.agentStart(undefined, "First", first);
  progress.agentStart(undefined, "Second", second);
  const stopped: number[] = [];
  const messages: { id: number; text: string; steer?: boolean }[] = [];
  let closed = 0;
  const terminal = { rows: 30 };
  progress.bindAgentStop(first, () => stopped.push(first));
  progress.bindAgentStop(second, () => stopped.push(second));
  progress.bindAgentFollowUp(first, async (text, steer) => { messages.push({ id: first, text, steer }); });
  progress.agentMessage(first, "task", "Private first agent task");
  const board = new WorkflowInspector(() => progress.snapshot(), { terminal, requestRender() {} } as any, theme,
    () => { closed++; }, undefined, {
      conversation: (id) => progress.conversation(id),
      followUp: (id, message, steer) => progress.followUp(id, message, steer),
      stopAgent: (id) => progress.stopAgent(id),
    });
  try {
    assert.match(board.render(79).join("\n"), /resize to inspect/);
    board.handleInput("\r");
    assert.doesNotMatch(board.render(79).join("\n"), /Private first agent task/);
    terminal.rows = 23;
    board.render(100);
    board.handleInput("\r");
    assert.doesNotMatch(board.render(100).join("\n"), /Private first agent task/);
    terminal.rows = 30;
    board.render(100);
    board.handleInput("\r");
    assert.match(board.render(100).join("\n"), /Private first agent task/);
    board.handleInput("X");
    board.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(messages, [{ id: first, text: "X", steer: true }]);
    assert.deepEqual(stopped, []);
    board.handleInput("\u001b");
    assert.equal(closed, 0);
    board.handleInput("j");
    board.handleInput("X");
    assert.deepEqual(stopped, [second]);
    assert.equal(progress.snapshot().phases[0].agents[1].status, "stopping");
    progress.agentFailed("Second", new WorkflowAgentStoppedError("Stopped"), second);
    assert.equal(progress.snapshot().phases[0].agents[1].status, "stopped");
    progress.agentDone("Second", second);
    assert.equal(progress.snapshot().phases[0].agents[1].status, "stopped");
    assert.equal(progress.snapshot().phases[0].agents[0].status, "running");
    board.handleInput("\u001b");
    assert.equal(closed, 1);
  } finally { progress.done(); }
});

test("stopping a queued agent removes its semaphore waiter without aborting siblings", async () => {
  const semaphore = new Semaphore(1);
  const progress = tracker();
  let release!: () => void;
  const active = semaphore.run(() => new Promise<void>((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const id = progress.agentQueued(undefined, "Queued");
  const unbind = progress.bindAgentStop(id, () => controller.abort(new WorkflowAgentStoppedError("Stopped")));
  let ran = false;
  try {
    const results = parallel([
      () => semaphore.run(async () => { ran = true; }, { signal: controller.signal }),
      () => semaphore.run(async () => "sibling"),
    ]);
    progress.stopAgent(id);
    release();
    await active;
    assert.deepEqual(await results, [null, "sibling"]);
    assert.equal(ran, false);
  } finally { unbind(); progress.done(); }
});

test("agent messages preserve multiline input and are delivered only to the selected binding", async () => {
  const progress = tracker();
  const sent: string[] = [];
  try {
    const id = progress.agentQueued(undefined, "Only");
    const unbind = progress.bindAgentFollowUp(id, async (text) => { sent.push(text); });
    const text = `First line\n${"x".repeat(3000)}`;
    await progress.followUp(id, text);
    assert.deepEqual(sent, [text]);
    unbind();
    await assert.rejects(progress.followUp(id, "too late"), /no longer accepting/);
  } finally { progress.done(); }
});

test("native transcript renders streaming text, thinking, and actual tool output", () => {
  initTheme("dark");
  const view = new AgentTranscriptView();
  const message = {
    role: "assistant", api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: 1,
    content: [{ type: "thinking", thinking: "Displayed thinking block" }, { type: "text", text: "Live answer" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as any;
  const rows = view.render({ messages: [message, { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Actual file output" }], isError: false, timestamp: 2 }], steering: [], followUp: [] }, 100, { requestRender() {} } as any, process.cwd());
  assert.match(rows.join("\n"), /Live answer/);
  assert.match(rows.join("\n"), /Displayed thinking block/);
  assert.match(rows.join("\n"), /Actual file output/);
});

test("workflow runtime integration", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--experimental-transform-types", "--test", "tests/fixtures/workflow-runtime.ts"], { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
  assert.match(output, /runAgent binds cancellation/);
  assert.match(output, /# fail 0/);
});
