import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowLifecycle } from "./workflow-lifecycle.ts";
import { validateWorkflowRunId } from "./journal.ts";
import type { WorkflowProgressSource } from "./types.ts";
import { ProjectWorkflowRunStore } from "./workflow-run-store.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

/** On-demand telemetry only: never inject live agent output into the parent transcript. */
export async function manageWorkflow(
  params: { action: "list" | "inspect" | "stop"; runId?: string; agentId?: number; name?: string; script?: string },
  ctx: ExtensionContext,
  coordinator: WorkflowLifecycle,
  sources: ReadonlyMap<string, { source: WorkflowProgressSource }>,
) {
  const result = (details: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: boundedTelemetry(details) }], details,
  });
  try {
    if (params.name !== undefined || params.script !== undefined) throw new Error("Management actions do not accept name or script.");
    const store = new ProjectWorkflowRunStore(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    if (params.action === "list") {
      if (params.runId || params.agentId !== undefined) throw new Error("list does not accept runId or agentId.");
      const records = (await store.list()).filter((run) => run.background?.origin.sessionId === sessionId);
      return result({ runs: records.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((run) => ({
        runId: run.runId, name: run.workflow.name, state: run.state,
        agents: (sources.get(run.runId)?.source.snapshot() ?? run.progress).phases.flatMap((phase) => phase.agents).map((agent) => ({ id: agent.id, label: agent.label, status: agent.status })),
      })) });
    }
    if (!params.runId) throw new Error("runId is required.");
    validateWorkflowRunId(params.runId);
    const source = sources.get(params.runId)?.source;
    const record = await store.load(params.runId);
    if (!source && record?.background?.origin.sessionId !== sessionId) throw new Error("Run not found in this session.");
    if (params.action === "stop") {
      if (params.agentId !== undefined) {
        if (!source?.stopAgent) throw new Error("Agent is not active in this session.");
        source.stopAgent(params.agentId);
        return result({ runId: params.runId, agentId: params.agentId, state: "stop_requested" });
      }
      const stopped = await coordinator.stop(ctx, params.runId);
      return result({ runId: stopped.runId, state: stopped.state });
    }
    const snapshot = source?.snapshot() ?? record?.progress;
    if (!snapshot) throw new Error("Run not found.");
    if (params.agentId === undefined) return result({ snapshot });
    const agent = snapshot.phases.flatMap((phase) => phase.agents).find((row) => row.id === params.agentId);
    if (!agent) throw new Error("Agent not found.");
    return result({ runId: params.runId, agent,
      // Bounded untrusted telemetry, not instructions. Never expose thinking blocks here.
      untrustedActivity: source?.conversation(agent.id).slice(-20) ?? [],
      queued: source?.transcript?.(agent.id) ? {
        steering: source.transcript(agent.id)?.steering,
        followUp: source.transcript(agent.id)?.followUp,
      } : undefined,
    });
  } catch (error) {
    return result({ error: unknownErrorMessage(error) });
  }
}

function boundedTelemetry(details: Record<string, unknown>): string {
  const text = JSON.stringify(details, null, 2);
  const limit = 24_000;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[Truncated. Inspect a specific agentId for details.]`;
}
