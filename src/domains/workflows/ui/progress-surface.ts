import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowProgressSnapshot } from "../runs/progress-types.ts";
import { renderWorkflowWidgetLines } from "./workflow-widget.ts";

/** Disposable presentation only; ProgressTracker owns the run state. */
export class WorkflowProgressSurface {
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private readonly key: string;
  private readonly ctx: ExtensionContext;
  private readonly title: string;
  private readonly snapshot: () => WorkflowProgressSnapshot;

  constructor(ctx: ExtensionContext, title: string, runId: string, snapshot: () => WorkflowProgressSnapshot) {
    this.ctx = ctx;
    this.title = title;
    this.snapshot = snapshot;
    this.key = `workflow:${runId}`;
  }

  log(message: string): void {
    if (!this.ctx.hasUI) process.stderr.write(`[${this.title}] ${message}\n`);
  }

  refresh(): void {
    if (!this.ctx.hasUI || this.disposed) return;
    const snapshot = this.snapshot();
    if (snapshot.doneAt !== undefined) return;
    this.render(snapshot);
    this.timer ??= setInterval(() => this.render(), 1_000);
  }

  private render(snapshot = this.snapshot()): void {
    if (this.disposed) return;
    if (snapshot.doneAt !== undefined) return;
    this.ctx.ui.setWidget(this.key, renderWorkflowWidgetLines(snapshot, this.ctx.ui.theme), { placement: "aboveEditor" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.ctx.hasUI) this.ctx.ui.setWidget(this.key, undefined);
  }
}
