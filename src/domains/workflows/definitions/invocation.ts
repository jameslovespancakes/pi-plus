import type { WorkflowRunOptions } from "../types.ts";
import { parseWorkflowBudgetString, parseWorkflowIntegerString } from "./options.ts";

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
      optionErrors.push("--inspect was removed; open the running workflow with /workflow");
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
    if (token === "--agent-retries" || token.startsWith("--agent-retries=")) {
      optionErrors.push("Account failover and request retries are automatic; remove --agent-retries.");
      if (token === "--agent-retries" && /^\d+$/.test(tokens[i + 1] ?? "")) i++;
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

export interface WorkflowToolRequestParams {
  readonly name?: string;
  readonly script?: string;
  readonly resumeFromRunId?: string;
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
