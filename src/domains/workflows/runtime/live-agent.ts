import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentRunnerSession, RunContext } from "./agent-runner-types.ts";
import { isWorkflowThinkingLevel } from "./agent-options.ts";
import { resolveAgentModel } from "./agent-session.ts";

export interface AgentTranscript {
  readonly cwd?: string;
  readonly messages: readonly AgentMessage[];
  readonly streaming?: AgentMessage;
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly toolUpdates?: ReadonlyMap<string, { result: AgentToolResult<unknown>; isPartial: boolean; isError: boolean }>;
}

/** Commands are scoped to the child SDK session; parent command handlers never run here. */
export async function sendAgentInput(session: AgentRunnerSession, rc: RunContext, text: string, steer = false): Promise<void> {
  const [command, ...rest] = text.trim().split(/\s+/);
  const argument = rest.join(" ");
  if (command === "/model") {
    if (!argument || !session.setModel) throw new Error("Usage: /model provider/model");
    const model = resolveAgentModel(argument, rc.modelRegistry, rc.hostModel).model;
    if (!model) throw new Error("Model is unavailable.");
    await session.setModel(model);
    return;
  }
  if (command === "/thinking") {
    if (!isWorkflowThinkingLevel(argument) || !session.setThinkingLevel) {
      throw new Error("Usage: /thinking off|minimal|low|medium|high|xhigh|max");
    }
    session.setThinkingLevel(argument);
    return;
  }
  if (command.startsWith("/")) throw new Error("Supported agent commands: /model provider/model, /thinking level.");
  if (!session.isStreaming) throw new Error("This agent has finished its current turn.");
  if (steer && session.steer) await session.steer(text);
  else await session.followUp(text);
}
