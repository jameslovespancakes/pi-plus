import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { isAdvisoryReport } from "./runtime/advisory-schema.ts";
import type { WorkflowProgressSnapshot } from "./runtime/progress-types.ts";
import type { LoadedWorkflow, WorkflowProgressSource, WorkflowRef, WorkflowRunMetadata, WorkflowRunOptions } from "./runtime/types.ts";
import { WorkflowInspector } from "./runtime/ui/workflow-inspector.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "./runtime/ui/workflow-viewer-layout.ts";
import type { PerfSink } from "./runtime/perf.ts";
import type { WorkflowUsageSnapshot } from "./runtime/usage.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE, registerDynamax } from "./runtime/dynamax.ts";
import { sessionKey } from "./runtime/session-identity.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./runtime/dynamax-shortcuts.ts";
import { ReviewSessionCoordinator } from "./runtime/review/review-session-coordinator.ts";
import {
  formatWorkflowDetailLines,
  isWorkflowResult,
  renderWorkflowResult,
} from "./runtime/ui/workflow-result-renderer.ts";
import {
  parseWorkflowBudgetString,
  parseWorkflowIntegerString,
  resolveWorkflowRunOptions,
  type ResolvedWorkflowRunOptions,
  WORKFLOW_AGENT_TIMEOUT_MAX_MS,
  WORKFLOW_AGENT_TIMEOUT_MIN_MS,
  WORKFLOW_AGENT_RETRIES_MAX,
  WORKFLOW_AGENT_RETRIES_MIN,
  WORKFLOW_BUDGET_MAX,
  WORKFLOW_BUDGET_MIN,
  WORKFLOW_MAX_AGENTS_MAX,
  WORKFLOW_MAX_AGENTS_MIN,
  WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
  WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN,
  WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS,
  WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
} from "./runtime/options.ts";
import { executeWorkflowInvocation, type WorkflowExecution, type WorkflowPerfDetails } from "./runtime/workflow-execution.ts";
import { BackgroundWorkflowCoordinator } from "./runtime/background-workflows.ts";
import { backgroundUnavailableResult, startBackgroundWorkflowTool } from "./runtime/background-workflow-tool.ts";
import { WorkflowRunController } from "./runtime/workflow-run-controller.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./runtime/command-completions.ts";
import { assertSupportedPiVersion } from "./runtime/pi-compat.ts";
import { formatWorkflowInspection, workflowInspectionSnapshot } from "./runtime/ui/workflow-format.ts";

/** Root used for bundled and project workflow discovery. */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

function summarize(result: unknown): string {
  if (typeof result === "object" && result !== null && "summary" in result && typeof result.summary === "string") return result.summary;
  return typeof result === "string" ? result : "Workflow finished.";
}

function formatMessageContent(
  name: string,
  result: unknown,
  usage?: WorkflowUsageSnapshot,
  perf?: WorkflowPerfDetails,
  metadata?: WorkflowRunMetadata,
): string {
  const details = formatWorkflowDetailLines({ usage, perf, metadata });
  return `## Workflow: ${name}\n\n${formatResultForContext(result)}${details.length > 0 ? `\n\n${details.join("\n")}` : ""}`;
}

function formatResultForContext(result: unknown): string {
  if (!isAdvisoryReport(result)) return summarize(result);

  const lines = [result.summary];
  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    result.findings.forEach((finding, index) => {
      const id = `R${String(index + 1).padStart(3, "0")}`;
      lines.push(
        `\n### ${id}: ${finding.summary}`,
        `- Severity: ${finding.severity}`,
        `- Confidence: ${finding.confidence}`,
        `- Category: ${finding.category}`,
        `- Location: ${finding.locations.map(formatFindingLocation).join(", ")}`,
        `- Impact: ${finding.impact}`,
        `- Evidence: ${finding.evidence.length > 0 ? finding.evidence.join("; ") : "(none cited)"}`,
        `- Recommendation: ${finding.recommendation}`,
      );
    });
  }
  if (result.nextSteps.length > 0) {
    lines.push("", "Next steps:", ...result.nextSteps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

function formatFindingLocation(location: { readonly file: string; readonly line?: number; readonly symbol?: string }): string {
  const line = location.line === undefined ? "" : `:${location.line}`;
  const symbol = location.symbol === undefined ? "" : ` (${location.symbol})`;
  return `${location.file}${line}${symbol}`;
}

type DiscoveryModule = typeof import("./runtime/discovery.ts");
type EngineModule = typeof import("./runtime/engine.ts");
type InlineWorkflowModule = typeof import("./runtime/inline-workflow.ts");

async function loadDiscovery(): Promise<DiscoveryModule> {
  return await import("./runtime/discovery.ts");
}

async function loadEngine(): Promise<EngineModule> {
  return await import("./runtime/engine.ts");
}

async function loadInlineWorkflow(): Promise<InlineWorkflowModule> {
  return await import("./runtime/inline-workflow.ts");
}

async function createInvocationPerf(options: ResolvedWorkflowRunOptions): Promise<PerfSink | undefined> {
  if (!options.perf) return undefined;
  const { createPerfRecorder } = await import("./runtime/perf.ts");
  return createPerfRecorder(true);
}

/**
 * Resolve an `api.workflow()` reference to a registered workflow module. Throws on an unknown name.
 */
export async function resolveWorkflowRef(ref: WorkflowRef, perf?: PerfSink): Promise<LoadedWorkflow> {
  const { discoverWorkflows } = await loadDiscovery();
  const workflows = await discoverWorkflows(EXTENSION_DIR, { perf });
  const mod = workflows.get(ref);
  if (!mod) {
    const available = [...workflows.keys()].join(", ") || "(none)";
    throw new Error(`Unknown workflow "${ref}". Available: ${available}`);
  }
  return mod;
}

const WORKFLOW_OPTION_COMPLETIONS = [
  { value: "--inspect", description: "Open the live workflow inspector" },
  { value: "--refresh", description: "Refresh dynamic workflow discovery" },
  { value: "--perf", description: "Collect workflow performance metrics" },
  { value: "--result-viewer", description: "Open supported result viewers" },
  { value: "--no-result-viewer", description: "Skip supported result viewers" },
  { value: "--resume-edited", description: "Allow resume after workflow source edits" },
  { value: "--concurrency=", description: "Optionally cap concurrent subagents" },
  { value: "--parallel-limit=", description: "Set the parallel submission limit" },
  { value: "--max-agents=", description: "Set the maximum admitted live agents" },
  { value: "--agent-timeout-ms=", description: "Set the timeout for each agent attempt" },
  { value: "--agent-retries=", description: "Set retries for each agent call" },
  { value: "--budget=", description: "Set the workflow output-token budget" },
  { value: "--resume=", description: "Resume from a retained workflow run ID" },
] as const;

async function workflowArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
  const parts = splitArgumentPrefix(argumentPrefix);
  if (parts.completed.length === 0) {
    const { discoverWorkflows } = await loadDiscovery();
    const workflows = await discoverWorkflows(EXTENSION_DIR);
    return completeCurrentArgument(
      argumentPrefix,
      [...workflows.values()].map((workflow) => ({
        value: workflow.meta.name,
        description: workflow.meta.description,
      })),
    );
  }
  return completeCurrentArgument(argumentPrefix, WORKFLOW_OPTION_COMPLETIONS);
}

export interface ActiveWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
  readonly source: WorkflowProgressSource;
  readonly snapshot: () => WorkflowProgressSnapshot;
}

interface SessionWorkflowInspections {
  readonly active: Map<string, ActiveWorkflowInspection>;
}

const workflowInspections = new WeakMap<ExtensionAPI, Map<string, SessionWorkflowInspections>>();

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
          () => workflowInspectionSnapshot(inspection),
          tui,
          theme,
          () => done(undefined),
          undefined,
          source,
        );
      },
      WORKFLOW_VIEWER_OVERLAY_OPTIONS,
    );
  } finally {
    unsubscribe?.();
  }
}

function workflowInspectionState(pi: ExtensionAPI, ctx: ExtensionContext): SessionWorkflowInspections {
  const sessions = workflowInspections.get(pi) ?? new Map<string, SessionWorkflowInspections>();
  const key = sessionKey(ctx);
  const state = sessions.get(key) ?? { active: new Map<string, ActiveWorkflowInspection>() };
  sessions.set(key, state);
  workflowInspections.set(pi, sessions);
  return state;
}

async function openAvailableWorkflowInspector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const state = workflowInspectionState(pi, ctx);
  const inspection = [...state.active.values()].sort((left, right) => right.startedAt - left.startedAt)[0];
  if (!inspection) {
    ctx.ui.notify("No workflow is currently running", "warning");
    return;
  }
  await openWorkflowInspector(ctx, inspection);
}

function bindActiveWorkflowInspection(name: string, args: string, source: WorkflowProgressSource): ActiveWorkflowInspection {
  return { name, args, startedAt: Date.now(), source, snapshot: () => source.snapshot() };
}

export interface WorkflowInvocation {
  name: string;
  args: string;
  options: WorkflowRunOptions;
  refreshDiscovery?: boolean;
  optionErrors?: string[];
}

export function parseWorkflowInvocation(input: string): WorkflowInvocation {
  const trimmed = input.trim();
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const { args, options, refreshDiscovery, optionErrors } = parseWorkflowOptions(rest);
  const invocation: WorkflowInvocation = { name, args, options };
  if (refreshDiscovery) invocation.refreshDiscovery = refreshDiscovery;
  if (optionErrors) invocation.optionErrors = optionErrors;
  return invocation;
}

const INVALID_BUDGET_OPTION = "--budget requires a positive integer output-token count";
const INVALID_RESUME_OPTION = "--resume requires a workflow run id";
const INVALID_MAX_AGENTS_OPTION = "--max-agents requires an integer";
const INVALID_AGENT_TIMEOUT_OPTION = "--agent-timeout-ms requires an integer";
const INVALID_AGENT_RETRIES_OPTION = "--agent-retries requires an integer";
const INVALID_EDITED_RESUME_OPTION = "--resume-edited requires --resume <run-id>";

function parseWorkflowOptions(input: string): { args: string; options: WorkflowRunOptions; refreshDiscovery?: boolean; optionErrors?: string[] } {
  const tokens = input.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const options: WorkflowRunOptions = {};
  const optionErrors: string[] = [];
  let refreshDiscovery = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--inspect") {
      options.inspect = true;
      continue;
    }
    if (token === "--refresh") {
      refreshDiscovery = true;
      continue;
    }
    if (token === "--perf") {
      options.perf = true;
      continue;
    }
    if (token === "--resume-edited") {
      options.resumeEditedWorkflow = true;
      continue;
    }
    if (token === "--result-viewer" || token === "--review-viewer") {
      options.resultViewer = "open";
      continue;
    }
    if (token === "--no-result-viewer" || token === "--no-review-viewer") {
      options.resultViewer = "skip";
      continue;
    }
    if (token.startsWith("--concurrency=")) {
      options.concurrency = parseNumericOption(token.slice("--concurrency=".length));
      continue;
    }
    if (token === "--concurrency") {
      const next = tokens[i + 1];
      options.concurrency = parseNumericOption(next);
      if (next !== undefined) i++;
      continue;
    }
    if (token.startsWith("--parallel-limit=")) {
      options.parallelSubmissionLimit = parseNumericOption(token.slice("--parallel-limit=".length));
      continue;
    }
    if (token === "--parallel-limit") {
      const next = tokens[i + 1];
      options.parallelSubmissionLimit = parseNumericOption(next);
      if (next !== undefined) i++;
      continue;
    }
    if (token.startsWith("--max-agents=")) {
      const parsed = parseWorkflowIntegerString(token.slice("--max-agents=".length));
      if (parsed === undefined) optionErrors.push(INVALID_MAX_AGENTS_OPTION);
      else options.maxAgents = parsed;
      continue;
    }
    if (token === "--max-agents") {
      const next = tokens[i + 1];
      const parsed = parseWorkflowIntegerString(next);
      if (parsed === undefined) optionErrors.push(INVALID_MAX_AGENTS_OPTION);
      else {
        options.maxAgents = parsed;
        i++;
      }
      continue;
    }
    if (token.startsWith("--agent-timeout-ms=")) {
      const parsed = parseWorkflowIntegerString(token.slice("--agent-timeout-ms=".length));
      if (parsed === undefined) optionErrors.push(INVALID_AGENT_TIMEOUT_OPTION);
      else options.agentTimeoutMs = parsed;
      continue;
    }
    if (token === "--agent-timeout-ms") {
      const next = tokens[i + 1];
      const parsed = parseWorkflowIntegerString(next);
      if (parsed === undefined) optionErrors.push(INVALID_AGENT_TIMEOUT_OPTION);
      else {
        options.agentTimeoutMs = parsed;
        i++;
      }
      continue;
    }
    if (token.startsWith("--agent-retries=")) {
      const parsed = parseWorkflowIntegerString(token.slice("--agent-retries=".length));
      if (parsed === undefined) optionErrors.push(INVALID_AGENT_RETRIES_OPTION);
      else options.agentRetries = parsed;
      continue;
    }
    if (token === "--agent-retries") {
      const next = tokens[i + 1];
      const parsed = parseWorkflowIntegerString(next);
      if (parsed === undefined) optionErrors.push(INVALID_AGENT_RETRIES_OPTION);
      else {
        options.agentRetries = parsed;
        i++;
      }
      continue;
    }
    if (token.startsWith("--budget=")) {
      const parsed = parseBudgetOption(token.slice("--budget=".length));
      if (parsed === undefined) optionErrors.push(INVALID_BUDGET_OPTION);
      else options.budget = parsed;
      continue;
    }
    if (token === "--budget") {
      const next = tokens[i + 1];
      const parsed = next === undefined ? undefined : parseBudgetOption(next);
      if (parsed === undefined) {
        optionErrors.push(INVALID_BUDGET_OPTION);
      } else {
        options.budget = parsed;
        i++;
      }
      continue;
    }
    if (token.startsWith("--resume=")) {
      const value = token.slice("--resume=".length).trim();
      if (value === "") optionErrors.push(INVALID_RESUME_OPTION);
      else options.resumeFromRunId = value;
      continue;
    }
    if (token === "--resume") {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        optionErrors.push(INVALID_RESUME_OPTION);
      } else {
        options.resumeFromRunId = next;
        i++;
      }
      continue;
    }
    kept.push(token);
  }
  if (options.resumeEditedWorkflow && !options.resumeFromRunId) optionErrors.push(INVALID_EDITED_RESUME_OPTION);
  return { args: kept.join(" ").trim(), options, refreshDiscovery: refreshDiscovery || undefined, optionErrors: optionErrors.length > 0 ? optionErrors : undefined };
}

function parseBudgetOption(value: string): number | undefined {
  return parseWorkflowBudgetString(value);
}

function parseNumericOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactInlinePreview(script: string | undefined): string {
  if (!script) return "";
  const compact = script.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact;
}

export interface WorkflowToolRequestParams {
  readonly name?: string;
  readonly script?: string;
  readonly resumeFromRunId?: string;
  readonly background?: boolean;
}

export type WorkflowToolRequest =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "inline"; readonly script: string }
  | { readonly kind: "error"; readonly error: "invalid_workflow_invocation"; readonly message: string };

export interface WorkflowToolErrorResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: { readonly error: "invalid_workflow_invocation" } | { readonly error: "inline_compile_error"; readonly message: string };
}

const INVALID_WORKFLOW_INVOCATION_MESSAGE = "Provide exactly one workflow name or inline workflow script.";

export function normalizeWorkflowToolRequest(params: WorkflowToolRequestParams): WorkflowToolRequest {
  const name = params.name?.trim() ?? "";
  const script = params.script?.trim() ?? "";
  const hasName = name.length > 0;
  const hasScript = script.length > 0;
  if (hasName === hasScript) return { kind: "error", error: "invalid_workflow_invocation", message: INVALID_WORKFLOW_INVOCATION_MESSAGE };
  return hasName ? { kind: "named", name } : { kind: "inline", script };
}

export function invalidWorkflowInvocationResult(): WorkflowToolErrorResult {
  return { content: [{ type: "text", text: INVALID_WORKFLOW_INVOCATION_MESSAGE }], details: { error: "invalid_workflow_invocation" } };
}

export function inlineCompileErrorResult(message: string): WorkflowToolErrorResult {
  return { content: [{ type: "text", text: `Inline workflow did not compile: ${message}` }], details: { error: "inline_compile_error", message } };
}

export async function sendWorkflowResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: WorkflowRunOptions,
  perfRecorder?: PerfSink,
  reviewSessions: ReviewSessionCoordinator = createReviewSessionCoordinator(pi),
): Promise<void> {
  await sendResolvedWorkflowResult(
    pi,
    ctx,
    name,
    mod,
    args,
    resolveWorkflowRunOptions(options),
    perfRecorder,
    reviewSessions,
  );
}

async function sendResolvedWorkflowResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder: PerfSink | undefined,
  reviewSessions: ReviewSessionCoordinator,
): Promise<void> {
  const execution = await executeResolvedWorkflow(pi, ctx, name, mod, args, options, perfRecorder);
  reviewSessions.remember(ctx, execution, options);
  sendWorkflowExecution(pi, execution);
  await reviewSessions.present(ctx, execution, options);
}

async function executeResolvedWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder?: PerfSink,
): Promise<WorkflowExecution> {
  const { runResolvedWorkflow } = await loadEngine();
  let liveInspection: ActiveWorkflowInspection | undefined;
  const inspections = workflowInspectionState(pi, ctx);
  return await executeWorkflowInvocation({
    ctx,
    name,
    mod,
    args,
    options,
    perfRecorder,
    runResolvedWorkflow,
    resolveWorkflow: (ref) => resolveWorkflowRef(ref, perfRecorder),
    onProgressSource(source) {
      if (source) {
        liveInspection = bindActiveWorkflowInspection(name, args, source);
        inspections.active.set(source.snapshot().runId, liveInspection);
      } else if (liveInspection) {
        inspections.active.delete(liveInspection.source.snapshot().runId);
        liveInspection = undefined;
      }
    },
  });
}

function sendWorkflowExecution(pi: ExtensionAPI, execution: WorkflowExecution): void {
  const { name } = execution.envelope;
  pi.sendMessage(
    {
      customType: "workflow-result",
      content: formatMessageContent(
        name,
        execution.envelope.result,
        execution.envelope.usage,
        execution.envelope.perf,
        execution.metadata,
      ),
      display: true,
      details: execution.envelope,
    },
    { triggerTurn: false },
  );
}

function createReviewSessionCoordinator(pi: ExtensionAPI): ReviewSessionCoordinator {
  return new ReviewSessionCoordinator(pi, {
    async runFollowUp(ctx, workflow, options) {
      const perfRecorder = await createInvocationPerf(options);
      return await executeResolvedWorkflow(pi, ctx, workflow.meta.name, workflow, "", options, perfRecorder);
    },
    publish: (execution) => sendWorkflowExecution(pi, execution),
  });
}

export default function workflowEngine(pi: ExtensionAPI, shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts()): void {
  assertSupportedPiVersion(VERSION);
  const reviewSessions = createReviewSessionCoordinator(pi);
  const backgroundWorkflows = new BackgroundWorkflowCoordinator(pi);
  const workflowRuns = new WorkflowRunController(backgroundWorkflows, {
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
  backgroundWorkflows.onRunSettled((ctx, runId) => workflowRuns.runSettled(ctx, runId));
  registerDynamax(pi, shortcuts, { openInspector: (ctx) => openAvailableWorkflowInspector(pi, ctx) });
  pi.on("session_start", async (_event, ctx) => {
    await backgroundWorkflows.sessionStarted(ctx);
    await workflowRuns.sessionStarted(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await backgroundWorkflows.agentSettled(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    workflowRuns.sessionShutdown(ctx);
    await backgroundWorkflows.sessionShutdown(ctx);
    const key = sessionKey(ctx);
    workflowInspections.get(pi)?.delete(key);
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

  pi.registerMessageRenderer("workflow-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (isWorkflowResult(details)) {
      return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, {
        runId: details.runId,
        resumedFromRunId: details.resumedFromRunId,
      }, details.perf);
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
      await sendResolvedWorkflowResult(pi, ctx, direct.name, mod, direct.args, directOptions, perfRecorder, reviewSessions);
    },
  });

  registerWorkflowTool(pi, reviewSessions, backgroundWorkflows);
}

/** Register the host-facing workflow tool independently from command and lifecycle surfaces. */
function registerWorkflowTool(
  pi: ExtensionAPI,
  reviewSessions: ReviewSessionCoordinator,
  backgroundWorkflows: BackgroundWorkflowCoordinator,
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "ONLY call workflow when the user opted in with the literal token `dynamax`, explicitly requested a workflow, or invoked a command or skill that requires one. Runs named or inline multi-agent workflows synchronously or in the background.",
    promptSnippet: "Run an existing named workflow or an inline one-off workflow script",
    promptGuidelines: [
      "Use workflow only after a `dynamax` opt-in, an explicit workflow request, or a command or skill instruction.",
      "Use workflow with `name` for existing registered workflows such as code-review, diagnose, refactor-scout, or perf-review.",
      "Use workflow with `script` for a new one-off inline workflow; the script must start with `export const meta = { ... }` and default-export an async workflow function.",
      "Inline workflow scripts must use the injected `Type` object for schemas and must not contain imports or dynamic import().",
      "Inline scripts may compose registered workflows in-process via `api.workflow(\"<name>\", args)` (e.g. `await api.workflow(\"code-review\", \"HEAD~3\")`); it returns the sub-workflow's result and nests one level only.",
      "Subagents receive no skills by default. In inline workflows, pass `skills: [\"skill-name\"]` per `agent()` call when the user asks for a skill or a stage should use one; grant only the needed skills.",
      "Always pass a plain string as the first `api.agent()` argument; build prompts with template strings before calling agent().",
      "When using `isolation: \"worktree\"`, `api.agent()` returns `{ result, patch, changed }`; use `.result` for the answer and `.patch` for the isolated diff.",
      "If an inline subagent needs grep/find/code-search helpers, use `tools: [\"read\", \"bash\", \"grep\", \"find\", \"ls\"]` plus `toolHints: [\"search\"]` so installed tools such as ast-grep, mgrep, ffgrep, or fffind are discovered dynamically.",
      "`api.budget` exposes `{ total, spent(), remaining() }` (output tokens). When the run is budgeted, scale fleets from `budget.total` and guard loops with `while (budget.total && budget.remaining() > N) { await api.agent(...) }`; `api.agent()` throws once the ceiling is reached.",
      ADAPTIVE_WORKFLOW_GUIDANCE,
      "Set background: true only when the user explicitly wants the workflow to continue after this tool call; the tool returns a durable run ID and completion is delivered later.",
      "Set autoResumeOnUsageLimit: true only for an explicitly backgrounded workflow when the user wants bounded automatic continuation after a recognized provider usage window.",
      "Set resumeEditedWorkflow: true only with resumeFromRunId when the user explicitly accepts reusing behaviorally identical calls after workflow source edits.",
      "Every workflow tool call must provide exactly one of `name` or `script`, never both.",
    ],
    parameters: Type.Object({
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
      agentRetries: Type.Optional(
        Type.Integer({
          description: `Retries per agent for classified transient provider failures; clamped to ${WORKFLOW_AGENT_RETRIES_MIN}-${WORKFLOW_AGENT_RETRIES_MAX}`,
        }),
      ),
      autoResumeOnUsageLimit: Type.Optional(
        Type.Boolean({ description: "For a background run, opt into bounded automatic resume after a recognized provider usage limit" }),
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
      background: Type.Optional(Type.Boolean({ description: "Return a durable run ID immediately and deliver completion to this conversation later" })),
    }),
    renderCall(args, theme) {
      const suffix = args.args ? ` ${theme.fg("dim", args.args)}` : "";
      const background = args.background ? ` ${theme.fg("dim", "(background)")}` : "";
      if (args.name?.trim()) {
        return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", args.name.trim())}${background}${suffix}`, 0, 0);
      }
      const preview = compactInlinePreview(args.script);
      const previewSuffix = preview ? ` ${theme.fg("dim", preview)}` : "";
      return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", "inline")}${background}${suffix}${previewSuffix}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("accent", "Running workflow…"), 0, 0);
      const details = result.details;
      if (isWorkflowResult(details)) {
        return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, {
          runId: details.runId,
          resumedFromRunId: details.resumedFromRunId,
        }, details.perf);
      }
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "Workflow finished.";
      return new Text(theme.fg("muted", text), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      if (params.background) {
        const unavailable = backgroundUnavailableResult(ctx.mode);
        if (unavailable) return unavailable;
      }

      const runOptions = resolveWorkflowRunOptions({
        inspect: ctx.hasUI && ctx.mode === "tui",
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        maxAgents: params.maxAgents,
        agentTimeoutMs: params.agentTimeoutMs,
        agentRetries: params.agentRetries,
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
      if (params.background) {
        return await startBackgroundWorkflowTool({
          coordinator: backgroundWorkflows,
          ctx,
          name: resultName,
          options: runOptions,
          async execute(backgroundCtx, backgroundOptions) {
            const execution = await executeResolvedWorkflow(
              pi,
              backgroundCtx,
              resultName,
              mod,
              resultArgs,
              backgroundOptions,
              perfRecorder,
            );
            reviewSessions.remember(ctx, execution, backgroundOptions);
          },
        });
      }
      const execution = await executeResolvedWorkflow(pi, ctx, resultName, mod, resultArgs, runOptions, perfRecorder);
      reviewSessions.remember(ctx, execution, runOptions);
      return {
        content: [{
          type: "text",
          text: formatMessageContent(
            resultName,
            execution.envelope.result,
            execution.envelope.usage,
            execution.envelope.perf,
            execution.metadata,
          ),
        }],
        details: execution.envelope,
      };
    },
  });
}
