import type { WorkflowRunOptions } from "./types.ts";

export const WORKFLOW_BUDGET_MIN = 1;
export const WORKFLOW_BUDGET_MAX = 1_000_000_000;
export const WORKFLOW_MAX_AGENTS_MIN = 1;
export const WORKFLOW_MAX_AGENTS_MAX = 10_000;
export const WORKFLOW_AGENT_TIMEOUT_MIN_MS = 1_000;
export const WORKFLOW_AGENT_TIMEOUT_MAX_MS = 86_400_000;
export const WORKFLOW_AGENT_RETRIES_MIN = 0;
export const WORKFLOW_AGENT_RETRIES_MAX = 10;
export const DEFAULT_WORKFLOW_AGENT_RETRIES = 0;
export const WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN = 1;
export const WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX = 10;
export const DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS = 3;
export const WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS = 5_000;
export const WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS = 86_400_000;
export const DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS = 21_600_000;

export type ResolvedWorkflowRunOptions = Omit<
  WorkflowRunOptions,
  | "perf"
  | "concurrency"
  | "parallelSubmissionLimit"
  | "maxAgents"
  | "agentTimeoutMs"
  | "agentRetries"
  | "autoResumeOnUsageLimit"
  | "usageLimitMaxAttempts"
  | "usageLimitMaxDelayMs"
  | "usageLimitAttempt"
  | "resumeEditedWorkflow"
  | "budget"
> & {
  readonly perf: boolean;
  readonly concurrency: number | null;
  readonly parallelSubmissionLimit: number | null;
  readonly maxAgents: number | null;
  readonly agentTimeoutMs: number | null;
  readonly agentRetries: number;
  readonly autoResumeOnUsageLimit: boolean;
  readonly usageLimitMaxAttempts: number;
  readonly usageLimitMaxDelayMs: number;
  readonly usageLimitAttempt: number;
  readonly resumeEditedWorkflow: boolean;
  readonly budget: number | null;
};

export function resolveWorkflowRunOptions(
  input: WorkflowRunOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedWorkflowRunOptions {
  const concurrency = optionalClampedInteger(
    input.concurrency ?? parseInteger(env.PI_WORKFLOW_CONCURRENCY),
    1,
    64,
  );
  const parallelSubmissionLimit = optionalClampedInteger(
    input.parallelSubmissionLimit ?? parseInteger(env.PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT),
    1,
    10_000,
  );
  const maxAgents = optionalClampedInteger(
    input.maxAgents ?? parseWorkflowIntegerString(env.PI_WORKFLOW_MAX_AGENTS),
    WORKFLOW_MAX_AGENTS_MIN,
    WORKFLOW_MAX_AGENTS_MAX,
  );
  const agentTimeoutMs = optionalClampedInteger(
    input.agentTimeoutMs ?? parseWorkflowIntegerString(env.PI_WORKFLOW_AGENT_TIMEOUT_MS),
    WORKFLOW_AGENT_TIMEOUT_MIN_MS,
    WORKFLOW_AGENT_TIMEOUT_MAX_MS,
  );
  const agentRetries = clampInteger(
    input.agentRetries ?? parseWorkflowIntegerString(env.PI_WORKFLOW_AGENT_RETRIES),
    WORKFLOW_AGENT_RETRIES_MIN,
    WORKFLOW_AGENT_RETRIES_MAX,
    DEFAULT_WORKFLOW_AGENT_RETRIES,
  );
  const budget = resolveBudget(input.budget, env.PI_WORKFLOW_BUDGET);
  const usageLimitMaxAttempts = clampInteger(
    input.usageLimitMaxAttempts ?? parseWorkflowIntegerString(env.PI_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS),
    WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN,
    WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
    DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS,
  );
  const usageLimitMaxDelayMs = clampInteger(
    input.usageLimitMaxDelayMs ?? parseWorkflowIntegerString(env.PI_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS),
    WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
    WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS,
    DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS,
  );
  return {
    ...input,
    perf: input.perf ?? env.PI_WORKFLOW_PERF === "1",
    concurrency: concurrency ?? null,
    parallelSubmissionLimit: parallelSubmissionLimit ?? null,
    maxAgents: maxAgents ?? null,
    agentTimeoutMs: agentTimeoutMs ?? null,
    agentRetries,
    autoResumeOnUsageLimit: input.autoResumeOnUsageLimit ?? env.PI_WORKFLOW_USAGE_LIMIT_AUTO_RESUME === "1",
    usageLimitMaxAttempts,
    usageLimitMaxDelayMs,
    usageLimitAttempt: clampInteger(
      input.usageLimitAttempt,
      0,
      WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
      0,
    ),
    resumeEditedWorkflow: input.resumeEditedWorkflow === true && hasResumeRunId(input.resumeFromRunId),
    budget: budget ?? null,
  };
}

function hasResumeRunId(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalClampedInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return clampInteger(value, min, max, value);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

export function parseWorkflowIntegerString(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolveBudget(inputBudget: number | undefined, envBudget: string | undefined): number | undefined {
  if (inputBudget !== undefined) return normalizeExplicitBudget(inputBudget);
  return envBudget === undefined ? undefined : parseWorkflowBudgetString(envBudget);
}

function normalizeExplicitBudget(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < WORKFLOW_BUDGET_MIN || value > WORKFLOW_BUDGET_MAX) {
    throw new RangeError(`Workflow budget must be an integer between ${WORKFLOW_BUDGET_MIN} and ${WORKFLOW_BUDGET_MAX}.`);
  }
  return value;
}

export function parseWorkflowBudgetString(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < WORKFLOW_BUDGET_MIN || parsed > WORKFLOW_BUDGET_MAX) return undefined;
  return parsed;
}
