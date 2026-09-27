import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedWorkflow } from "../types.ts";
import type { PerfSink } from "./perf.ts";
import type { ResolvedWorkflowRunOptions } from "../definitions/options.ts";
import { executeWorkflowInvocation, type WorkflowExecution } from "./workflow-execution.ts";
import { loadEngine, resolveWorkflowRef } from "../definitions/loader.ts";
import { bindLiveRun } from "../runs/live-runs.ts";

export async function executeResolvedWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder?: PerfSink,
): Promise<WorkflowExecution> {
  const { runResolvedWorkflow } = await loadEngine();
  const onProgressSource = bindLiveRun(pi, ctx, name, args);
  try {
    return await executeWorkflowInvocation({
      ctx, name, mod, args, options, perfRecorder, runResolvedWorkflow,
      resolveWorkflow: (ref) => resolveWorkflowRef(ref, perfRecorder),
      onProgressSource,
    });
  } finally {
    onProgressSource(undefined);
  }
}
