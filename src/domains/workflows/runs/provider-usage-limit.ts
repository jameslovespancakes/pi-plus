import { WorkflowPauseError } from "../execution/cancellation.ts";
import { recoveryWasPartial } from "../../../providers/shared/accounts/request-recovery.ts";
import { WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS, type ResolvedWorkflowRunOptions } from "../definitions/options.ts";
import type { WorkflowProviderUsageLimitPause } from "./workflow-run-record.ts";
import { isAccountLimitMessage, parseProviderResetHint } from "../../../providers/shared/accounts/provider-errors.ts";
export { parseProviderResetHint } from "../../../providers/shared/accounts/provider-errors.ts";

export const WORKFLOW_PROVIDER_USAGE_LIMIT_CODE = "WORKFLOW_PROVIDER_USAGE_LIMIT";
export const WORKFLOW_USAGE_LIMIT_FALLBACK_DELAY_MS = 60_000;

export interface ProviderUsageLimitDetails {
  readonly stopReason: "error";
  readonly providerMessage: string;
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
  readonly resetHint?: string;
  readonly resetAt?: number;
}
export interface ProviderUsageLimitPauseRecord {
  readonly message: string;
  readonly pause: WorkflowProviderUsageLimitPause;
}

/** Request-level recovery has finished; the remaining limit can pause the workflow. */
export class WorkflowProviderUsageLimitError extends WorkflowPauseError {
  override readonly name = "WorkflowProviderUsageLimitError";
  readonly code = WORKFLOW_PROVIDER_USAGE_LIMIT_CODE;
  readonly details: ProviderUsageLimitDetails;
  constructor(details: ProviderUsageLimitDetails) {
    super(details.providerMessage);
    this.details = details;
  }
  toJSON() {
    return { name: this.name, message: this.message, code: this.code, details: this.details };
  }
}

export function providerUsageLimitFromMessages(messages: readonly unknown[], now = Date.now()): WorkflowProviderUsageLimitError | undefined {
  const message = messages.findLast(isAssistantMessage);
  if (!message || message.stopReason !== "error" || recoveryWasPartial(message)) return undefined;
  const providerMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!providerMessage || !isAccountLimitMessage(providerMessage)) return undefined;
  const provider = stringDetail(message.provider), model = stringDetail(message.model), api = stringDetail(message.api);
  return new WorkflowProviderUsageLimitError({
    stopReason: "error", providerMessage,
    ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(api ? { api } : {}),
    ...parseProviderResetHint(providerMessage, now),
  });
}

export function createProviderUsageLimitPauseRecord(
  error: WorkflowProviderUsageLimitError, options: ResolvedWorkflowRunOptions,
  replayableInvocation: boolean, now = Date.now(),
): ProviderUsageLimitPauseRecord {
  const attempt = options.usageLimitAttempt + 1;
  const hintedDelay = error.details.resetAt === undefined ? WORKFLOW_USAGE_LIMIT_FALLBACK_DELAY_MS : error.details.resetAt - now;
  const delayMs = Math.min(options.usageLimitMaxDelayMs, Math.max(WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
    hintedDelay > 0 ? hintedDelay : WORKFLOW_USAGE_LIMIT_FALLBACK_DELAY_MS));
  const autoResume = options.autoResumeOnUsageLimit && attempt < options.usageLimitMaxAttempts && replayableInvocation;
  return {
    message: autoResume
      ? `Provider usage limit paused this run; automatic attempt ${attempt + 1}/${options.usageLimitMaxAttempts} is scheduled.`
      : `Provider usage limit paused this run at attempt ${attempt}/${options.usageLimitMaxAttempts}.`,
    pause: {
      kind: "provider_usage_limit", reason: "provider_usage_limit", providerMessage: error.details.providerMessage,
      provider: error.details.provider, model: error.details.model, api: error.details.api,
      resetHint: error.details.resetHint, attempt, nextEligibleAt: now + delayMs,
      autoResume, maxAttempts: options.usageLimitMaxAttempts,
    },
  };
}

function isAssistantMessage(value: unknown): value is {
  readonly role: "assistant"; readonly stopReason?: unknown; readonly errorMessage?: unknown;
  readonly provider?: unknown; readonly model?: unknown; readonly api?: unknown; readonly diagnostics?: unknown;
} {
  return typeof value === "object" && value !== null && "role" in value && value.role === "assistant";
}
function stringDetail(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
