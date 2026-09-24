import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Semaphore, parallel } from "../src/domains/workflows/runtime/concurrency.ts";
import { workflowRunsDir } from "../src/domains/workflows/runtime/journal.ts";
import { resolveWorkflowRunOptions } from "../src/domains/workflows/runtime/options.ts";
import { toDisplayLine, toDisplayText } from "../src/domains/workflows/runtime/ui/display-text.ts";
import { WorkflowInspector } from "../src/domains/workflows/runtime/ui/workflow-inspector.ts";
import { renderWorkflowWidgetLines } from "../src/domains/workflows/runtime/ui/workflow-widget.ts";
import { ProgressTracker } from "../src/domains/workflows/runtime/progress.ts";
import { WorkflowUsageRecorder } from "../src/domains/workflows/runtime/usage.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("workflow semaphore enforces its cap", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 8 }, (_, index) => semaphore.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await wait(2 + index % 2);
    active--;
  })));
  assert.equal(peak, 2);
});

test("parallel preserves order and isolates recoverable failures", async () => {
  const result = await parallel([
    async () => { await wait(5); return "first"; },
    async () => { throw new Error("expected"); },
    async () => "third",
  ], { limit: 2 });
  assert.deepEqual(result, ["first", null, "third"]);
});

test("workflow display text is stable and single-line", () => {
  assert.equal(toDisplayLine("one\n\u001B[31mtwo\u001B[0m", 20), "one two");
  assert.equal(toDisplayLine("123456", 5), "1234…");
  assert.equal(toDisplayText("one\r\n\u001B[31m**two**\u001B[0m", 20), "one\n**two**");
});

test("workflow records stay outside the repository", () => {
  const cwd = join(process.cwd(), "nested-project");
  const path = workflowRunsDir(cwd);
  assert.equal(path.startsWith(cwd), false);
  assert.match(path, /nested-project-[a-f0-9]{8}$/);
});

test("workflow limits are opt-in", () => {
  const options = resolveWorkflowRunOptions({}, {});
  assert.equal(options.concurrency, null);
  assert.equal(options.maxAgents, null);
  assert.equal(options.agentTimeoutMs, null);
  assert.equal(options.parallelSubmissionLimit, null);
  assert.equal(options.budget, null);
  assert.equal(options.agentRetries, 0);

  const limited = resolveWorkflowRunOptions({ concurrency: 3, maxAgents: 8, agentTimeoutMs: 5_000, budget: 2_000 }, {});
  assert.equal(limited.concurrency, 3);
  assert.equal(limited.maxAgents, 8);
  assert.equal(limited.agentTimeoutMs, 5_000);
  assert.equal(limited.budget, 2_000);
});

test("workflow progress and usage stay available without a footer status line", () => {
  const statuses: (string | undefined)[] = [];
  const widgets: unknown[] = [];
  const tracker = new ProgressTracker({
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      setWidget: (_key: string, widget: unknown) => widgets.push(widget),
    },
  } as any, "review", "footer-test");
  const usage = new WorkflowUsageRecorder().snapshot();
  try {
    const id = tracker.agentQueued(undefined, "Review");
    tracker.agentStart(undefined, "Review", id);
    tracker.updateUsage(usage);
    assert.deepEqual(statuses, []);
    assert.ok(widgets.length > 0);
    assert.equal(tracker.snapshot().usage, usage);
    assert.equal(tracker.statusCounts().running, 1);
  } finally {
    tracker.done();
  }
  assert.deepEqual(statuses, [undefined]);
});

test("workflow widget is a compact agent board", () => {
  const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const lines = renderWorkflowWidgetLines({
    runId: "run-1",
    title: "review",
    currentPhase: "Checks",
    startedAt: Date.now() - 2_000,
    phases: [{
      title: "Checks",
      agents: [{ id: 1, label: "Audit routing", model: "openai-codex/gpt-test", status: "running", startedAt: Date.now() - 1_000, toolUses: 2, lastTool: "read" }],
    }],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  }, plainTheme);
  assert.match(lines.join("\n"), /Audit routing/);
  assert.match(lines.join("\n"), /codex\/gpt-test/);
  assert.match(lines.join("\n"), /\/workflow/);
  assert.doesNotMatch(lines.join("\n"), /\/workflow info/);
});

test("workflow board opens agent chat and sends a follow-up", async () => {
  let renders = 0;
  const followUps: string[] = [];
  const foregrounds: string[] = [];
  const backgrounds: string[] = [];
  const plainTheme = {
    fg: (color: string, text: string) => { foregrounds.push(color); return text; },
    bg: (color: string, text: string) => { backgrounds.push(color); return text; },
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  } as any;
  const snapshot = {
    runId: "run-1",
    title: "review",
    currentPhase: "Checks",
    startedAt: Date.now() - 2_000,
    phases: [{
      title: "Checks",
      agents: [{ id: 1, label: "Audit routing", model: "openai-codex/gpt-test", status: "running" as const, startedAt: Date.now() - 1_000, toolUses: 2, lastTool: "read" }],
    }],
    counters: [], summary: [], lanes: [], laneOverflow: [], logs: [],
  };
  const board = new WorkflowInspector(
    () => snapshot,
    { requestRender: () => { renders++; }, terminal: { rows: 30 } as any },
    plainTheme,
    () => {},
    undefined,
    {
      conversation: () => [
        { role: "task", text: "Review OAuth routing", createdAt: Date.now() },
        { role: "tool", text: "read", createdAt: Date.now() },
        { role: "assistant", text: "# Finding\nToken refresh is safe.", createdAt: Date.now() },
      ],
      followUp: async (_agentId, message) => { followUps.push(message); },
    },
  );
  assert.doesNotMatch(board.render(80).join("\n"), /Review OAuth routing/);
  board.handleMouse({ type: "click", button: "left", x: 2, y: 5, screenX: 2, screenY: 5, width: 80, height: 24, shift: false, alt: false, ctrl: false });
  const chat = board.render(80);
  assert.match(chat.join("\n"), /Review OAuth routing/);
  assert.match(chat.join("\n"), /Token refresh is safe/);
  assert.match(chat.join("\n"), /follow-up to this agent/);
  assert.doesNotMatch(chat.join("\n"), /following latest activity/);
  assert.ok(backgrounds.includes("userMessageBg"));
  assert.ok(backgrounds.includes("toolPendingBg"));
  assert.ok(foregrounds.includes("mdHeading"));
  assert.ok(chat.every((line) => visibleWidth(line) <= 80));

  for (const char of "Check refresh races") board.handleInput(char);
  board.handleInput("\r");
  await wait(0);
  assert.deepEqual(followUps, ["Check refresh races"]);
  assert.ok(renders > 1);
});

test("built-in workflows and one command surface are bundled directly", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./src/domains/workflows/index.ts"));
  const settings = JSON.parse(readFileSync(join(process.cwd(), "config", "pi", "settings.json"), "utf8"));
  assert.equal(settings.packages.includes("npm:pi-workflow-engine"), false);

  const entry = readFileSync(join(process.cwd(), "src", "domains", "workflows", "index.ts"), "utf8");
  const dynamax = readFileSync(join(process.cwd(), "src", "domains", "workflows", "runtime", "dynamax.ts"), "utf8");
  assert.equal(entry.match(/registerCommand\("workflow"/g)?.length, 1);
  assert.doesNotMatch(`${entry}\n${dynamax}`, /registerCommand\("workflow:/);
  assert.doesNotMatch(entry, /\/workflow info|name === "info"/);
});
