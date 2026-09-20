import { throwIfAborted } from "./cancellation.ts";

export class WorkflowAgentLimitError extends Error {
  override readonly name = "WorkflowAgentLimitError";
  readonly code = "WORKFLOW_AGENT_LIMIT_EXCEEDED";
  readonly maxAgents: number;

  constructor(maxAgents: number) {
    super(`Workflow live-agent limit of ${maxAgents} has been reached; no new model request was started.`);
    this.maxAgents = maxAgents;
  }
}

export class WorkflowAgentTimeoutError extends Error {
  override readonly name = "WorkflowAgentTimeoutError";
  readonly code = "WORKFLOW_AGENT_TIMEOUT";
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`Workflow agent "${label}" exceeded its ${timeoutMs}ms duration limit.`);
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** Shared run-level admission counter. Cache hits do not call admit(). */
export interface WorkflowAgentReservation {
  /** Permanently count this reservation as a live model attempt. */
  commit(): void;
  /** Return an uncommitted reservation after setup or replay succeeds/fails. */
  release(): void;
}

export class WorkflowAgentLimiter {
  readonly maxAgents: number | null;
  private admitted = 0;

  constructor(maxAgents: number | null) {
    this.maxAgents = maxAgents;
  }

  reserve(signal: AbortSignal | undefined): WorkflowAgentReservation {
    throwIfAborted(signal);
    if (this.maxAgents !== null && this.admitted >= this.maxAgents) {
      throw new WorkflowAgentLimitError(this.maxAgents);
    }
    this.admitted++;
    let state: "pending" | "committed" | "released" = "pending";
    return {
      commit() {
        if (state === "released") throw new Error("Cannot commit a released workflow agent reservation.");
        state = "committed";
      },
      release: () => {
        if (state !== "pending") return;
        state = "released";
        this.admitted--;
      },
    };
  }

  admit(signal: AbortSignal | undefined): void {
    this.reserve(signal).commit();
  }
}
