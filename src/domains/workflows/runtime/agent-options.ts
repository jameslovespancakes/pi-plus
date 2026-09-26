import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "./types.ts";

export const WORKFLOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export function isWorkflowThinkingLevel(value: string): value is ThinkingLevel {
  return (WORKFLOW_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Validate before admission or any model session can be created. */
export function assertAgentOptions(options: unknown): asserts options is AgentOptions {
  const opts = options as Partial<AgentOptions> | undefined;
  if (!opts || typeof opts.label !== "string" || !opts.label.trim()
    || typeof opts.model !== "string" || !opts.model.trim()
    || typeof opts.thinkingLevel !== "string" || !isWorkflowThinkingLevel(opts.thinkingLevel)) {
    throw new Error("Every agent() requires explicit label, model, and thinkingLevel.");
  }
}
