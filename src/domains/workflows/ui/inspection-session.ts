import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { liveRuns, type ActiveWorkflowInspection } from "../runs/live-runs.ts";
import { WorkflowInspector, WORKFLOW_INSPECTOR_OVERLAY_OPTIONS } from "./workflow-inspector.ts";
import { formatWorkflowInspection, workflowInspectionSnapshot } from "./workflow-format.ts";

export type { ActiveWorkflowInspection } from "../runs/live-runs.ts";

export async function openWorkflowInspector(ctx: ExtensionContext, inspection: ActiveWorkflowInspection): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(formatWorkflowInspection(inspection), "info");
    return;
  }
  let unsubscribe: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const { source } = inspection;
        unsubscribe = source.subscribe(() => tui.requestRender());
        return new WorkflowInspector(
          () => workflowInspectionSnapshot(inspection), tui, theme,
          () => done(undefined), undefined, source, _keybindings,
        );
      },
      WORKFLOW_INSPECTOR_OVERLAY_OPTIONS,
    );
  } finally {
    unsubscribe?.();
  }
}

export async function openAvailableWorkflowInspector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const inspection = [...liveRuns(pi, ctx).values()].sort((left, right) => right.startedAt - left.startedAt)[0];
  if (!inspection) {
    ctx.ui.notify("No workflow is currently running", "warning");
    return;
  }
  await openWorkflowInspector(ctx, inspection);
}
