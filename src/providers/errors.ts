import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { codexFailureReason, codexFailureText } from "./codex/errors.ts";
import { recoveryReason, type RecoveryReason } from "./shared/accounts/request-recovery.ts";

/** Composition of native pi classification and provider-specific exceptions. */
export function providerFailureReason(message: AssistantMessage): RecoveryReason | undefined {
  return recoveryReason(message) ?? (message.stopReason === "error" ? codexFailureReason(message) : undefined);
}

export function providerFailureRetryable(message: AssistantMessage): boolean {
  return isRetryableAssistantError(message) || codexFailureReason(message) !== undefined;
}

export function providerFailureText(message: AssistantMessage): string {
  const text = typeof message.errorMessage === "string" && message.errorMessage.length > 0
    ? message.errorMessage : "Provider session ended with an unspecified error.";
  return codexFailureText({ ...message, errorMessage: text }) ?? text;
}
