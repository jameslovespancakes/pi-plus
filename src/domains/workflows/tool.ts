import { Type } from "typebox";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { LoadedWorkflow } from "./types.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE } from "./ui/dynamax.ts";
import { ReviewSessionCoordinator } from "./review/review-session-coordinator.ts";
import { isWorkflowResult, renderWorkflowResult } from "./ui/workflow-result-renderer.ts";
import { resolveWorkflowRunOptions, WORKFLOW_AGENT_TIMEOUT_MAX_MS, WORKFLOW_AGENT_TIMEOUT_MIN_MS, WORKFLOW_BUDGET_MAX, WORKFLOW_BUDGET_MIN, WORKFLOW_MAX_AGENTS_MAX, WORKFLOW_MAX_AGENTS_MIN, WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX, WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN, WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS, WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS } from "./definitions/options.ts";
import { WorkflowLifecycle, workflowUnavailableResult } from "./runs/workflow-lifecycle.ts";
import { formatWorkflowTitle } from "./ui/workflow-format.ts";
import { liveRuns } from "./runs/live-runs.ts";
import { inlineCompileErrorResult, invalidWorkflowInvocationResult, normalizeWorkflowToolRequest } from "./definitions/invocation.ts";
import { EXTENSION_DIR, createInvocationPerf, loadDiscovery, loadInlineWorkflow } from "./definitions/loader.ts";
import { executeResolvedWorkflow } from "./execution/invocation.ts";

function compactInlinePreview(script: string | undefined): string {
  if (!script) return "";
  const compact = script.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact;
}

/** Register the host-facing workflow tool independently from command and lifecycle surfaces. */
export function registerWorkflowTool(
  pi: ExtensionAPI,
  reviewSessions: ReviewSessionCoordinator,
  lifecycle: WorkflowLifecycle,
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "ONLY call workflow when the user opted in with the literal token `dynamax`, explicitly requested a workflow, or invoked a command or skill that requires one. Starts named or inline multi-agent workflows and returns a run ID immediately. Use list, inspect, or stop to manage runs and individual agents.",
    promptSnippet: "Run an existing named workflow or an inline one-off workflow script",
    promptGuidelines: [
      "Use workflow only after a `dynamax` opt-in, an explicit workflow request, or a command or skill instruction.",
      "Use workflow with `name` for existing registered workflows such as code-review, diagnose, refactor-scout, or perf-review.",
      "Use workflow with `script` for a new one-off inline workflow; the script must start with `export const meta = { ... }` and default-export an async workflow function.",
      "Inline workflow scripts must use the injected `Type` object for schemas and must not contain imports or dynamic import().",
      "Inline scripts may compose registered workflows in-process via `api.workflow(\"<name>\", args)` (e.g. `await api.workflow(\"code-review\", \"HEAD~3\")`); it returns the sub-workflow's result and nests one level only.",
      "Subagents receive no skills by default. In inline workflows, pass `skills: [\"skill-name\"]` per `agent()` call when the user asks for a skill or a stage should use one; grant only the needed skills.",
      "Always pass a plain string as the first `api.agent()` argument; build prompts with template strings before calling agent().",
      "When using `isolation: \"worktree\"`, `api.agent()` returns `{ result, patch, changed }`; use `.result` for the answer and `.patch` for the isolated diff. Successful runs clean up the worktree; failed runs retain recoverable work and report its path.",
      "If an inline subagent needs grep/find/code-search helpers, use `tools: [\"read\", \"bash\", \"grep\", \"find\", \"ls\"]` plus `toolHints: [\"search\"]` so installed tools such as ast-grep, mgrep, ffgrep, or fffind are discovered dynamically.",
      "`api.budget` exposes `{ total, spent(), remaining() }` (output tokens). When the run is budgeted, scale fleets from `budget.total` and guard loops with `while (budget.total && budget.remaining() > N) { await api.agent(...) }`; `api.agent()` throws once the ceiling is reached.",
      ADAPTIVE_WORKFLOW_GUIDANCE,
      "All runs return a durable run ID immediately; completion is delivered later. Use action list/inspect/stop to observe or cancel without launching another workflow.",
      "Every api.agent() call must explicitly supply label, model, and thinkingLevel; no implicit host model or thinking defaults.",
      "Set autoResumeOnUsageLimit: true only when the user wants bounded automatic continuation after a recognized provider usage window.",
      "Set resumeEditedWorkflow: true only with resumeFromRunId when the user explicitly accepts reusing behaviorally identical calls after workflow source edits.",
      "Launch calls must provide exactly one of name or script. Management calls use action, runId, and optionally agentId instead.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("inspect"), Type.Literal("stop")], { description: "Defaults to start. Management actions do not launch a workflow." })),
      runId: Type.Optional(Type.String({ minLength: 1, description: "Run to inspect or stop" })),
      agentId: Type.Optional(Type.Integer({ minimum: 1, description: "Inspect or stop only this agent" })),
      name: Type.Optional(Type.String({ description: "Workflow name, e.g. code-review. Provide exactly one of name or script." })),
      script: Type.Optional(Type.String({ description: "Inline workflow script. Provide exactly one of script or name." })),
      args: Type.Optional(Type.String({ description: "Arguments for the workflow (e.g. target or focus)" })),
      concurrency: Type.Optional(Type.Number({ description: "Optional per-run agent concurrency cap" })),
      parallelSubmissionLimit: Type.Optional(Type.Number({ description: "Optional limit for eagerly submitted parallel thunks" })),
      maxAgents: Type.Optional(
        Type.Integer({
          description: `Optional live model-call limit; unlimited by default; clamped to ${WORKFLOW_MAX_AGENTS_MIN}-${WORKFLOW_MAX_AGENTS_MAX}`,
        }),
      ),
      agentTimeoutMs: Type.Optional(
        Type.Integer({
          description: `Optional per-agent timeout in milliseconds; disabled by default; clamped to ${WORKFLOW_AGENT_TIMEOUT_MIN_MS}-${WORKFLOW_AGENT_TIMEOUT_MAX_MS}`,
        }),
      ),
      autoResumeOnUsageLimit: Type.Optional(
        Type.Boolean({ description: "Opt into bounded automatic resume after a recognized provider usage limit" }),
      ),
      usageLimitMaxAttempts: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN,
          maximum: WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
          description: "Maximum total run attempts in one automatic provider-limit resume chain",
        }),
      ),
      usageLimitMaxDelayMs: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
          maximum: WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS,
          description: "Maximum delay accepted from a provider reset hint before automatic resume",
        }),
      ),
      budget: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_BUDGET_MIN,
          maximum: WORKFLOW_BUDGET_MAX,
          description: "Optional output-token ceiling for the run; agent() throws once it is exceeded",
        }),
      ),
      perf: Type.Optional(Type.Boolean({ description: "Include workflow performance timing aggregates in the result details" })),
      resumeFromRunId: Type.Optional(Type.String({ minLength: 1, description: "Workflow run id to resume from by replaying matching completed agent results" })),
      resumeEditedWorkflow: Type.Optional(
        Type.Boolean({ description: "With resumeFromRunId, ignore only workflow-source fingerprint changes while retaining all other replay checks" }),
      ),
    }),
    renderCall(args, theme) {
      const suffix = args.args ? ` ${theme.fg("dim", args.args)}` : "";
      if (args.action && args.action !== "start") return new Text(`▸ ${theme.fg("toolTitle", "workflow")} ${args.action} ${args.runId ?? ""}`, 0, 0);
      if (args.name?.trim()) {
        return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", formatWorkflowTitle(args.name))}${suffix}`, 0, 0);
      }
      const preview = compactInlinePreview(args.script);
      const previewSuffix = preview ? ` ${theme.fg("dim", preview)}` : "";
      return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", "Inline")}${suffix}${previewSuffix}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("accent", "Running workflow…"), 0, 0);
      const details = result.details;
      if (isWorkflowResult(details)) {
        return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, details, details.perf);
      }
      if (details && typeof details === "object" && "state" in details && details.state === "running" && "name" in details && typeof details.name === "string") {
        const title = theme.fg("accent", theme.bold(formatWorkflowTitle(details.name)));
        const run = expanded && "runId" in details ? `\nRun: ${details.runId}` : "";
        return new Text(`${title}\nRunning…${run}`, 0, 0);
      }
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "Workflow finished.";
      return new Text(theme.fg("muted", text), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action && params.action !== "start") {
        const { manageWorkflow } = await import("./runs/workflow-management.ts");
        return await manageWorkflow({ ...params, action: params.action }, ctx, lifecycle, liveRuns(pi, ctx));
      }
      if (params.runId !== undefined || params.agentId !== undefined) {
        return { content: [{ type: "text", text: "runId and agentId require inspect or stop." }], details: { error: "invalid_workflow_invocation" } };
      }
      const request = normalizeWorkflowToolRequest(params);
      if (request.kind === "error") return invalidWorkflowInvocationResult();
      const resumeFromRunId = params.resumeFromRunId?.trim();
      if (params.resumeFromRunId !== undefined && resumeFromRunId === "") {
        return {
          content: [{ type: "text", text: "resumeFromRunId must be non-empty." }],
          details: { error: "invalid_resume_from_run_id" },
        };
      }
      if (params.resumeEditedWorkflow && !resumeFromRunId) {
        return {
          content: [{ type: "text", text: "resumeEditedWorkflow requires resumeFromRunId." }],
          details: { error: "invalid_edited_workflow_resume" },
        };
      }
      const unavailable = workflowUnavailableResult(ctx.mode);
      if (unavailable) return unavailable;

      const runOptions = resolveWorkflowRunOptions({
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        maxAgents: params.maxAgents,
        agentTimeoutMs: params.agentTimeoutMs,
        autoResumeOnUsageLimit: params.autoResumeOnUsageLimit,
        usageLimitMaxAttempts: params.usageLimitMaxAttempts,
        usageLimitMaxDelayMs: params.usageLimitMaxDelayMs,
        budget: params.budget,
        perf: params.perf,
        resumeFromRunId,
        resumeEditedWorkflow: params.resumeEditedWorkflow,
        signal,
      });
      const perfRecorder = await createInvocationPerf(runOptions);
      let mod: LoadedWorkflow;
      let resultName: string;

      if (request.kind === "named") {
        const { discoverWorkflows } = await loadDiscovery();
        const workflows = await discoverWorkflows(EXTENSION_DIR, { perf: perfRecorder });
        const named = workflows.get(request.name);
        if (!named) {
          const available = [...workflows.keys()].join(", ") || "(none)";
          return {
            content: [{ type: "text", text: `Unknown workflow "${request.name}". Available: ${available}` }],
            details: { error: "unknown_workflow", available },
          };
        }
        mod = named;
        resultName = request.name;
      } else {
        const inline = await loadInlineWorkflow();
        try {
          mod = inline.compileInlineWorkflow(request.script);
        } catch (error) {
          if (error instanceof inline.InlineWorkflowCompileError) return inlineCompileErrorResult(error.message);
          throw error;
        }
        resultName = mod.meta.name;
      }

      const resultArgs = params.args ?? "";
      return await lifecycle.launch({
        ctx,
        name: resultName,
        options: runOptions,
        async execute(runCtx, options) {
          const execution = await executeResolvedWorkflow(pi, runCtx, resultName, mod, resultArgs, options, perfRecorder);
          reviewSessions.remember(ctx, execution, options);
        },
      });
    },
  });
}
