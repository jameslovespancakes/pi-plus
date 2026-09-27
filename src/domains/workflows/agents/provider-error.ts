import type { AssistantMessage } from "@earendil-works/pi-ai";
import { providerFailureRetryable, providerFailureText } from "../../../providers/errors.ts";
import {
  providerUsageLimitFromMessages,
  type WorkflowProviderUsageLimitError,
} from "../runs/provider-usage-limit.ts";

export const WORKFLOW_PROVIDER_ERROR_CODE = "WORKFLOW_PROVIDER_ERROR";

export interface ProviderErrorDetails {
  readonly stopReason: "error";
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
}

/** Provider failure reconstructed from pi's terminal assistant-message metadata. */
export class WorkflowProviderError extends Error {
  override readonly name = "WorkflowProviderError";
  readonly code = WORKFLOW_PROVIDER_ERROR_CODE;
  readonly details: ProviderErrorDetails;

  constructor(message: string, details: ProviderErrorDetails) {
    super(message);
    this.details = details;
  }

  get retryable(): boolean {
    return this.details.retryable;
  }

  toJSON(): {
    readonly name: string;
    readonly message: string;
    readonly code: string;
    readonly details: ProviderErrorDetails;
  } {
    return { name: this.name, message: this.message, code: this.code, details: this.details };
  }
}

export function providerErrorFromMessages(
  messages: readonly unknown[],
  options: { readonly pauseOnUsageLimit?: boolean } = {},
): WorkflowProviderError | WorkflowProviderUsageLimitError | undefined {
  const usageLimit = providerUsageLimitFromMessages(messages);
  if (usageLimit && options.pauseOnUsageLimit) return usageLimit;
  const message = messages.findLast(isAssistantMessage);
  if (!message || message.stopReason !== "error") return undefined;
  const provider = stringDetail(message.provider);
  const model = stringDetail(message.model);
  const api = stringDetail(message.api);
  const retryable = providerFailureRetryable(message as AssistantMessage);
  const errorMessage = providerFailureText(message as AssistantMessage);
  return new WorkflowProviderError(errorMessage, {
    stopReason: "error",
    retryable,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(api ? { api } : {}),
  });
}

function isAssistantMessage(value: unknown): value is {
  readonly role: "assistant";
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly api?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant"
  );
}

function stringDetail(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
