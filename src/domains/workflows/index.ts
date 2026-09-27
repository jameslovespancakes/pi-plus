import { VERSION, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerDynamax } from "./ui/dynamax.ts";
import { disposeLiveRuns } from "./runs/live-runs.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./ui/dynamax-shortcuts.ts";
import { ReviewSessionCoordinator } from "./review/review-session-coordinator.ts";
import { isWorkflowResult, renderWorkflowResult } from "./ui/workflow-result-renderer.ts";
import { resolveWorkflowRunOptions } from "./definitions/options.ts";
import { WorkflowLifecycle, workflowUnavailableResult } from "./runs/workflow-lifecycle.ts";
import { WorkflowRunController } from "./runs/workflow-run-controller.ts";
import { assertSupportedPiVersion } from "./definitions/pi-compat.ts";
import { EXTENSION_DIR, createInvocationPerf, loadDiscovery, workflowArgumentCompletions } from "./definitions/loader.ts";
import { executeResolvedWorkflow } from "./execution/invocation.ts";
import { openAvailableWorkflowInspector } from "./ui/inspection-session.ts";
import { parseWorkflowInvocation } from "./definitions/invocation.ts";
import { registerWorkflowTool } from "./tool.ts";

function createReviewSessionCoordinator(pi: ExtensionAPI, lifecycle: WorkflowLifecycle): ReviewSessionCoordinator {
  return new ReviewSessionCoordinator(pi, {
    async runFollowUp(ctx, workflow, options) {
      const perfRecorder = await createInvocationPerf(options);
      return lifecycle.runToCompletion({
        ctx, name: workflow.meta.name, options,
        execute: (runCtx, runOptions) => executeResolvedWorkflow(pi, runCtx, workflow.meta.name, workflow, "", runOptions, perfRecorder),
      });
    },
  });
}

export default function workflowEngine(pi: ExtensionAPI, shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts()): void {
  assertSupportedPiVersion(VERSION);
  const lifecycle = new WorkflowLifecycle(pi);
  const reviewSessions = createReviewSessionCoordinator(pi, lifecycle);
  const workflowRuns = new WorkflowRunController(lifecycle, {
    async resolveWorkflow(name) {
      const { discoverWorkflows } = await loadDiscovery();
      return (await discoverWorkflows(EXTENSION_DIR)).get(name);
    },
    async execute(ctx, name, workflow, options) {
      const perfRecorder = await createInvocationPerf(options);
      const execution = await executeResolvedWorkflow(pi, ctx, name, workflow, "", options, perfRecorder);
      reviewSessions.remember(ctx, execution, options);
    },
  });
  lifecycle.onRunSettled((ctx, runId) => workflowRuns.runSettled(ctx, runId));
  registerDynamax(pi, shortcuts, { openInspector: (ctx) => openAvailableWorkflowInspector(pi, ctx) });
  pi.on("session_start", async (_event, ctx) => {
    await lifecycle.sessionStarted(ctx);
    await workflowRuns.sessionStarted(ctx);
  });
  pi.on("agent_start", (_event, ctx) => lifecycle.agentStarted(ctx));
  pi.on("turn_end", (event, ctx) => lifecycle.beforeBoundary(ctx, event));
  pi.on("agent_before_settle", (event, ctx) => lifecycle.beforeBoundary(ctx, event));
  pi.on("agent_settled", async (_event, ctx) => {
    await lifecycle.agentSettled(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    workflowRuns.sessionShutdown(ctx);
    await lifecycle.sessionShutdown(ctx);
    disposeLiveRuns(pi, ctx);
    reviewSessions.dispose(ctx);
  });
  if (shortcuts.results) {
    pi.registerShortcut(shortcuts.results, {
      description: "Open last code-review results",
      handler: async (ctx) => {
        await reviewSessions.reopen(ctx);
      },
    });
  }

  pi.registerEntryRenderer("workflow-result", (entry, { expanded }, theme) => {
    const details = entry.data;
    if (!isWorkflowResult(details)) return;
    return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, details, details.perf);
  });
  // Keep rendering results already stored by older versions and review follow-ups.
  pi.registerMessageRenderer("workflow-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (isWorkflowResult(details)) {
      return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, details, details.perf);
    }
    return renderWorkflowResult("workflow", details ?? message.content, expanded, theme);
  });

  pi.registerCommand("workflow", {
    description: "Open the running workflow or run one by name",
    getArgumentCompletions: workflowArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const direct = parseWorkflowInvocation(args);
      if (!direct.name) {
        await openAvailableWorkflowInspector(pi, ctx);
        return;
      }
      if (direct.optionErrors?.length) {
        ctx.ui.notify(`Invalid workflow option: ${direct.optionErrors.join("; ")}`, "warning");
        return;
      }
      const directOptions = resolveWorkflowRunOptions(direct.options);
      const perfRecorder = await createInvocationPerf(directOptions);
      const { discoverWorkflows } = await loadDiscovery();
      const workflows = await discoverWorkflows(EXTENSION_DIR, { refresh: direct.refreshDiscovery, perf: perfRecorder });
      const available = [...workflows.keys()].join(", ") || "(none)";
      const mod = workflows.get(direct.name);
      if (!mod) {
        ctx.ui.notify(`Unknown workflow "${direct.name}". Available: ${available}`, "error");
        return;
      }
      const unavailable = workflowUnavailableResult(ctx.mode);
      if (unavailable) {
        ctx.ui.notify(unavailable.content[0].text, "warning");
        return;
      }
      const started = await lifecycle.launch({
        ctx, name: direct.name, options: directOptions,
        async execute(runCtx, options) {
          const execution = await executeResolvedWorkflow(pi, runCtx, direct.name, mod, direct.args, options, perfRecorder);
          reviewSessions.remember(ctx, execution, options);
        },
      });
      ctx.ui.notify(started.content[0].text, started.details.error ? "error" : "info");
    },
  });

  registerWorkflowTool(pi, reviewSessions, lifecycle);
}

export { resolveWorkflowRef } from "./definitions/loader.ts";

export { type ActiveWorkflowInspection, openWorkflowInspector } from "./ui/inspection-session.ts";

export { type WorkflowInvocation, parseWorkflowInvocation, type WorkflowToolRequestParams, type WorkflowToolRequest, type WorkflowToolErrorResult, normalizeWorkflowToolRequest, invalidWorkflowInvocationResult, inlineCompileErrorResult } from "./definitions/invocation.ts";
