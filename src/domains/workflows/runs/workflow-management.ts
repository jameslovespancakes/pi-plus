import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { WorkflowLifecycle } from "./workflow-lifecycle.ts";
import { validateWorkflowRunId } from "../replay/journal.ts";
import type { WorkflowProgressSource } from "../types.ts";
import type { AgentRowSnapshot, WorkflowProgressSnapshot } from "./progress-types.ts";
import { ProjectWorkflowRunStore } from "./workflow-run-store.ts";
import { unknownErrorMessage } from "../../../core/errors.ts";
import { toDisplayLine, toDisplayText } from "../ui/display-text.ts";

const RUN_LIMIT = 10;
const AGENT_LIMIT = 20;
export const WORKFLOW_ACTIVITY_LIMIT = 10;
const ACTIVITY_TEXT_LIMIT = 400;
const ACTIVITY_BUDGET = 4_000;

interface Activity {
  agentId: number;
  role: string;
  text: string;
  at?: number;
}

/** On-demand, bounded telemetry; raw snapshots and private thinking never enter tool output. */
export async function manageWorkflow(
  params: { action: "list" | "inspect" | "stop"; runId?: string; agentId?: number; name?: string; script?: string },
  ctx: ExtensionContext,
  coordinator: WorkflowLifecycle,
  sources: ReadonlyMap<string, { source: WorkflowProgressSource }>,
) {
  const result = (details: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(details) }], details,
  });
  try {
    if (params.name !== undefined || params.script !== undefined) throw new Error("Management actions do not accept name or script.");
    const store = new ProjectWorkflowRunStore(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    if (params.action === "list") {
      if (params.runId || params.agentId !== undefined) throw new Error("list does not accept runId or agentId.");
      const active = coordinator.activeRunIds(ctx);
      const records = (await store.list()).filter((run) => run.background?.origin.sessionId === sessionId && active.has(run.runId) && (run.state === "running" || run.state === "queued"));
      let remaining = AGENT_LIMIT;
      return result({ runs: records.sort((a, b) => b.createdAt - a.createdAt).slice(0, RUN_LIMIT).map((run) => {
        const snapshot = sources.get(run.runId)?.source.snapshot() ?? run.progress;
        const running = runningAgents(snapshot);
        const agents = running.slice(0, remaining).map(agentSummary);
        remaining -= agents.length;
        return { runId: run.runId, name: toDisplayLine(run.workflow.name, 80), state: run.state, agents,
          ...(running.length > agents.length && { omittedAgents: running.length - agents.length }) };
      }), ...(records.length > RUN_LIMIT && { omittedRuns: records.length - RUN_LIMIT }) });
    }
    if (!params.runId) throw new Error("runId is required.");
    validateWorkflowRunId(params.runId);
    const source = sources.get(params.runId)?.source;
    const record = await store.load(params.runId);
    if (record?.background?.origin.sessionId !== sessionId) throw new Error("Run not found in this session.");
    if (params.action === "stop") {
      if (params.agentId !== undefined) {
        if (!source?.stopAgent) throw new Error("Agent is not active in this session.");
        source.stopAgent(params.agentId);
        return result({ runId: params.runId, agentId: params.agentId, state: "stop_requested" });
      }
      const stopped = await coordinator.stop(ctx, params.runId);
      return result({ runId: stopped.runId, state: stopped.state });
    }
    const snapshot = source?.snapshot() ?? record.progress;
    const running = record.state === "running" || record.state === "queued" ? runningAgents(snapshot) : [];
    if (params.agentId !== undefined) {
      const agent = snapshot.phases.flatMap((phase) => phase.agents).find((row) => row.id === params.agentId);
      if (!agent) throw new Error("Agent not found.");
      if (!running.includes(agent)) return result({ runId: params.runId, agentId: agent.id, state: agent.status, message: "Agent is not running." });
      const transcript = source?.transcript?.(agent.id);
      return result({ runId: params.runId, agent: agentSummary(agent),
        untrustedActivity: boundActivity(agentActivity(source, agent.id)),
        ...(transcript && { queued: { steering: transcript.steering.length, followUp: transcript.followUp.length } }),
      });
    }
    const shown = running.slice(0, AGENT_LIMIT);
    return result({ runId: record.runId, name: toDisplayLine(record.workflow.name, 80), state: record.state,
      agents: shown.map(agentSummary),
      ...(running.length > shown.length && { omittedAgents: running.length - shown.length }),
      untrustedActivity: boundActivity(shown.flatMap((agent) => agentActivity(source, agent.id)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))),
    });
  } catch (error) {
    return result({ error: toDisplayText(unknownErrorMessage(error), 400) });
  }
}

function runningAgents(snapshot: WorkflowProgressSnapshot): AgentRowSnapshot[] {
  if (snapshot.doneAt !== undefined) return [];
  return snapshot.phases.flatMap((phase) => phase.agents).filter((agent) => agent.status === "running" || agent.status === "stopping");
}

function agentSummary(agent: AgentRowSnapshot) {
  return { id: agent.id, label: toDisplayLine(agent.label, 48), status: agent.status,
    ...(agent.model && { model: toDisplayLine(agent.model, 80) }),
    ...(agent.lastTool && { lastTool: toDisplayLine(agent.lastTool, 32) }),
  };
}

/** Prefer pi's actual transcript, including tool results, over progress breadcrumbs. */
function agentActivity(source: WorkflowProgressSource | undefined, agentId: number): Activity[] {
  const transcript = source?.transcript?.(agentId);
  if (!transcript) return (source?.conversation(agentId) ?? []).slice(-WORKFLOW_ACTIVITY_LIMIT).map((entry) => ({
    agentId, role: entry.role, text: toDisplayText(entry.text, ACTIVITY_TEXT_LIMIT), at: entry.createdAt,
  }));
  const messages = transcript.streaming && !transcript.messages.includes(transcript.streaming)
    ? [...transcript.messages, transcript.streaming] : transcript.messages;
  const activity: Activity[] = [];
  for (let index = messages.length - 1; index >= 0 && activity.length < WORKFLOW_ACTIVITY_LIMIT; index--) {
    const message = messages[index];
    const text = activityText(message);
    if (text) activity.push({ agentId, role: message.role, text, at: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : undefined });
  }
  return activity.reverse();
}

function activityText(message: AgentMessage): string | undefined {
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
  const blocks = typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "toolCall") return [`${part.name} ${JSON.stringify(part.arguments)}`];
    if (part.type === "image") return ["[image]"];
    return []; // Never expose private thinking or provider diagnostics.
  });
  const text = blocks.map((block) => toDisplayText(block, ACTIVITY_TEXT_LIMIT)).join("\n");
  return text ? toDisplayText(message.role === "toolResult" ? `${message.toolName}: ${text}` : text, ACTIVITY_TEXT_LIMIT) : undefined;
}

/** Bound both content and details, retaining valid JSON and the newest ten entries. */
function boundActivity(activity: Activity[]): Activity[] {
  const result: Activity[] = [];
  let remaining = ACTIVITY_BUDGET;
  for (const entry of activity.slice(-WORKFLOW_ACTIVITY_LIMIT).reverse()) {
    const overhead = JSON.stringify({ ...entry, text: "" }).length + 1;
    if (remaining <= overhead + 10) break;
    const bounded = { ...entry, text: toDisplayText(entry.text, Math.min(ACTIVITY_TEXT_LIMIT, Math.floor((remaining - overhead) / 2))) };
    remaining -= JSON.stringify(bounded).length + 1;
    result.push(bounded);
  }
  return result.reverse();
}
