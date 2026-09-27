import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowBudget } from "../execution/budget.ts";
import type { Semaphore } from "../execution/concurrency.ts";
import type { WorkflowAgentLimiter } from "../execution/agent-limits.ts";
import type { RecoveryScheduler } from "../../../providers/shared/accounts/request-recovery.ts";
import type { ResolvedWorkflowModelProfiles } from "../definitions/model-profiles.ts";
import type { WorkflowJournal } from "../replay/journal.ts";
import type { PerfSink } from "../execution/perf.ts";
import type { AgentOptions, WorkflowProgressEvent } from "../types.ts";
import type { AgentChatRole } from "../runs/progress-types.ts";
import type { AgentTranscript } from "./live-agent.ts";
import type { WorkflowUsageSink } from "../execution/usage.ts";
import type { WorktreeBaseline, WorktreeRegistry } from "../workspace/worktree.ts";

export type AgentRunnerSession = Pick<
  AgentSession,
  | "messages"
  | "systemPrompt"
  | "model"
  | "thinkingLevel"
  | "prompt"
  | "subscribe"
  | "dispose"
  | "abort"
  | "getAllTools"
  | "getActiveToolNames"
  | "getToolDefinition"
  | "setActiveToolsByName"
  | "setAutoRetryEnabled"
  | "getLastAssistantText"
  | "isStreaming"
  | "followUp"
> & Partial<Pick<AgentSession, "agent" | "setModel" | "setThinkingLevel" | "steer" | "getSteeringMessages" | "getFollowUpMessages">>;

export type CreateAgentSession = (options: CreateAgentSessionOptions) => Promise<{ session: AgentRunnerSession }>;

export interface AgentProgress {
  agentQueued(phase: string | undefined, label: string, model?: string, modelName?: string, thinkingLevel?: string): number;
  bindAgentStop?(id: number, stop: () => void): () => void;
  agentStart(phase: string | undefined, label: string, id?: number, model?: string): void;
  agentTool(label: string, tool: string, id?: number): void;
  agentMessage(id: number, role: AgentChatRole, text: string): void;
  bindAgentFollowUp(id: number, send: (message: string, steer?: boolean) => Promise<void>): () => void;
  bindAgentTranscript?(id: number, read: () => AgentTranscript): () => void;
  agentChanged?(id: number, model?: string, modelName?: string, thinkingLevel?: string): void;
  agentDone(label: string, id?: number): void;
  agentFailed(label: string, error: unknown, id?: number): void;
  event(event: WorkflowProgressEvent): void;
  log(message: string): void;
}

interface RunContextBase {
  cwd: string;
  hostModel: Model<Api> | undefined;
  semaphore: Semaphore;
  agentLimiter: WorkflowAgentLimiter;
  agentTimeoutMs: number | null;
  pauseOnProviderUsageLimit?: boolean;
  resumeEditedWorkflow?: boolean;
  retryScheduler: RecoveryScheduler;
  modelProfiles: ResolvedWorkflowModelProfiles;
  progress: AgentProgress;
  signal: AbortSignal | undefined;
  perf: PerfSink;
  usage: WorkflowUsageSink;
  budget: WorkflowBudget;
  journal: WorkflowJournal;
  worktrees: WorktreeRegistry;
}

/** Shared per-run context threaded into every agent() call. */
export type RunContext = RunContextBase & (
  | {
      /** Production sessions inherit the host's live provider and auth state. */
      modelRegistry: ModelRegistry;
      createSession?: undefined;
    }
  | {
      /** Injected test sessions bypass Pi's resource loader and therefore do not resolve skills. */
      modelRegistry: Pick<ModelRegistry, "find">;
      createSession: CreateAgentSession;
    }
);

/** Runtime-only options. The authored WorkflowApi exposes only AgentOptions. */
export type AgentExecutionOptions = AgentOptions & {
  readonly worktreeBaseline?: WorktreeBaseline;
};

export interface AgentRunTags {
  readonly [key: string]: string | number;
  readonly label: string;
  readonly phase: string;
}
