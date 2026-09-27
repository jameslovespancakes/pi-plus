import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ProgressTracker } from "../src/domains/workflows/runs/progress.ts";
import { WorkflowUsageRecorder } from "../src/domains/workflows/execution/usage.ts";
import { formatWorkflowHeading, formatWorkflowTitle } from "../src/domains/workflows/ui/workflow-format.ts";
import { renderWorkflowResult, renderWorkflowResultText } from "../src/domains/workflows/ui/workflow-result-renderer.ts";
import { renderWorkflowWidgetLines } from "../src/domains/workflows/ui/workflow-widget.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
function usage() {
  const snapshot = new WorkflowUsageRecorder().snapshot();
  return { ...snapshot, totals: { ...snapshot.totals, cost: { ...snapshot.totals.cost, total: 0.042 } } };
}
function tracker(options: { signal?: AbortSignal; onSnapshot?: (snapshot: any) => void } = {}) {
  const updates: { key: string; lines?: string[] }[] = [];
  const progress = new ProgressTracker({ hasUI: true, signal: options.signal,
    ui: { theme, setWidget: (key: string, lines?: string[]) => updates.push({ key, lines }) },
  } as any, "trace-launch-3", "run-3", options.onSnapshot);
  return { progress, updates };
}

test("workflow titles use one display-only formatter, preserving acronyms and numbers", () => {
  assert.equal(formatWorkflowTitle("trace-launch-2"), "Trace Launch 2");
  assert.equal(formatWorkflowTitle("  API__launch--3  "), "API Launch 3");
  assert.equal(formatWorkflowTitle("déjà-vu"), "Déjà Vu");
  assert.equal(formatWorkflowHeading("trace-launch-2", usage(), theme), "Trace Launch 2 · $0.042");
  assert.equal(formatWorkflowHeading("trace-launch-2", undefined, theme), "Trace Launch 2");
});

test("inline outcomes are compact and show cost beside the title, not a success tick for failures", () => {
  const cases = [
    ["completed", "Identified the startup failure.", "Finished: Identified the startup failure."],
    ["stopped", "Workflow stopped: Workflow stopped by user.", "Stopped: Cancelled at your request."],
    ["failed", "Workflow failed: Connection closed.", "Failed: Connection closed."],
    ["paused", "Usage limit reached.", "Paused: Usage limit reached."],
  ] as const;
  for (const [status, summary, outcome] of cases) {
    const metadata = { status, runId: "run-2" };
    const text = renderWorkflowResultText("trace-launch-2", { summary }, false, theme, usage(), metadata);
    assert.equal(text, `Trace Launch 2 · $0.042\n${outcome}`);
    assert.doesNotMatch(text, /✓|Run:|Usage:|Perf:/);
    const expanded = renderWorkflowResultText("trace-launch-2", { summary }, true, theme, usage(), metadata);
    assert.match(expanded, /Run: run-2/);
    assert.match(expanded, /Usage:/);
    const component = renderWorkflowResult("trace-launch-2", { summary }, false, theme, usage(), metadata);
    assert.ok(component.render(32).every((line) => visibleWidth(line) <= 32));
  }
});

test("working titles and cost match completed titles without altering snapshot identifiers", () => {
  const { progress } = tracker();
  try {
    progress.updateUsage(usage());
    const snapshot = progress.snapshot();
    assert.equal(snapshot.title, "trace-launch-3");
    assert.match(renderWorkflowWidgetLines(snapshot, theme)[0], /^Trace Launch 3 · \$0\.042/);
  } finally { progress.done(); }
});

test("live board shows failed agents before completed rows", () => {
  const { progress } = tracker();
  try {
    for (let i = 0; i < 15; i++) {
      const id = progress.agentQueued(undefined, `done-${i}`);
      progress.agentDone(`done-${i}`, id);
    }
    const failed = progress.agentQueued(undefined, "write:infer");
    progress.agentFailed("write:infer", new Error("429 limit"), failed);
    const running = progress.agentQueued(undefined, "write:bridges");
    progress.agentStart(undefined, "write:bridges", running);
    const lines = renderWorkflowWidgetLines(progress.snapshot(), theme);
    assert.match(lines[0], /15\/17 done · 1 failed/);
    assert.match(lines[1], /write:bridges/);
    assert.match(lines[2], /write:infer/);
  } finally { progress.done(); }
});

test("completion is idempotent and late updates cannot recreate a workflow widget or timer", async () => {
  const { progress, updates } = tracker();
  const id = progress.agentQueued(undefined, "Late agent");
  progress.done();
  const doneAt = progress.snapshot().doneAt;
  const clearedAt = updates.length;
  progress.log("late finalizer warning");
  progress.updateUsage(usage());
  progress.agentDone("Late agent", id);
  progress.done();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(updates.length, clearedAt);
  assert.equal(updates.at(-1)?.lines, undefined);
  assert.equal(progress.snapshot().doneAt, doneAt);
});

test("throwing completion observers cannot prevent widget cleanup", () => {
  const { progress, updates } = tracker({ onSnapshot(snapshot) { if (snapshot.doneAt) throw new Error("observer failed"); } });
  progress.phase("Working");
  assert.throws(() => progress.done(), /observer failed/);
  assert.equal(updates.at(-1)?.lines, undefined);
  assert.doesNotThrow(() => progress.done());
});

test("stop/shutdown abort clears only that workflow even if its task never settles", () => {
  const controller = new AbortController();
  const first = tracker({ signal: controller.signal });
  const sibling = tracker();
  try {
    first.progress.phase("Working");
    sibling.progress.phase("Working");
    controller.abort();
    assert.ok(first.progress.snapshot().doneAt);
    assert.equal(first.updates.at(-1)?.lines, undefined);
    assert.ok(sibling.updates.at(-1)?.lines);
    assert.equal(sibling.progress.snapshot().doneAt, undefined);
    const count = first.updates.length;
    first.progress.log("late callback");
    assert.equal(first.updates.length, count);
  } finally { first.progress.done(); sibling.progress.done(); }
});
