import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RecoveryReason } from "../shared/accounts/request-recovery.ts";

const ACCESS_VERIFICATION_ERROR = /Unable to verify\s+[^.\r\n]{1,120}\s+access\.\s*Please try again\.?/i;
type Failure = Pick<AssistantMessage, "provider" | "errorMessage" | "model">;

export function codexFailureReason(message: Failure): RecoveryReason | undefined {
  return message.provider === "openai-codex" && ACCESS_VERIFICATION_ERROR.test(message.errorMessage ?? "")
    ? "transient" : undefined;
}

export function codexFailureText(message: Failure): string | undefined {
  return codexFailureReason(message) && message.model
    ? `Codex temporarily could not verify access for the selected model ${message.provider}/${message.model}. No alternate model was requested. Provider response: ${message.errorMessage}`
    : undefined;
}
