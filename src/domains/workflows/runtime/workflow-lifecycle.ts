import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkflowAbortError, WorkflowPauseError } from "./cancellation.ts";
import type { WorkflowOrigin } from "./types.ts";
import { createWorkflowRunId } from "./journal.ts";
import type { ResolvedWorkflowRunOptions } from "./options.ts";
import {
  transitionWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunState,
} from "./workflow-run-record.ts";
import { updateWorkflowRunDelivery } from "./workflow-run-delivery.ts";
import { ProjectWorkflowRunStore, type WorkflowRunStore } from "./workflow-run-store.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { emptyWorkflowUsageTotals } from "./usage.ts";

const WORKFLOW_DELIVERY_CUSTOM_TYPE = "workflow-result";
const SHUTDOWN_WAIT_MS = 5_000;
const SUMMARY_LIMIT = 500;

interface WorkflowStartInput {
  readonly ctx: ExtensionContext;
  readonly runId: string;
  readonly name: string;
  readonly run: (signal: AbortSignal, onStarted: () => void) => Promise<void>;
}

export interface WorkflowCompletionDetails {
  readonly name: string;
  readonly result: { readonly summary: string };
  readonly completedAt: number;
  readonly usage: WorkflowRunRecord["usage"];
  readonly runId: string;
  readonly resumedFromRunId?: string;
  readonly status: WorkflowRunState;
}

export interface WorkflowLaunchResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: Readonly<Record<string, unknown>>;
}

export function workflowUnavailableResult(mode: ExtensionContext["mode"]): WorkflowLaunchResult | undefined {
  if (mode !== "print" && mode !== "json") return undefined;
  return {
    content: [{ type: "text", text: `Workflows require TUI/RPC mode; ${mode} mode exits after the prompt.` }],
    details: { error: "workflow_unavailable", mode },
  };
}

type SessionAvailability = "available" | "missing" | "unknown";

interface WorkflowLifecycleDependencies {
  readonly storeForCwd?: (cwd: string) => WorkflowRunStore;
  readonly sessionAvailability?: (cwd: string, sessionId: string) => Promise<SessionAvailability>;
  readonly log?: (message: string) => void;
  readonly shutdownWaitMs?: number;
}

interface ActiveWorkflowRun {
  readonly controller: AbortController;
  readonly name: string;
  readonly sessionId: string;
  readonly settled: Promise<void>;
  readonly isSettled: () => boolean;
}

type WorkflowSettledListener = (ctx: ExtensionContext, runId: string) => void | Promise<void>;

/** The single workflow lifecycle: launch, cancellation, recovery and durable delivery. */
export class WorkflowLifecycle {
  private readonly active = new Map<string, ActiveWorkflowRun>();
  private readonly settledListeners = new Set<WorkflowSettledListener>();
  private readonly pendingDelivery = new Map<string, Set<string>>();
  private readonly shuttingDown = new Set<string>();
  private readonly storeForCwd: (cwd: string) => WorkflowRunStore;
  private readonly sessionAvailability: (cwd: string, sessionId: string) => Promise<SessionAvailability>;
  private readonly log: (message: string) => void;
  private readonly shutdownWaitMs: number;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    dependencies: WorkflowLifecycleDependencies = {},
  ) {
    this.storeForCwd = dependencies.storeForCwd ?? ((cwd) => new ProjectWorkflowRunStore(cwd));
    this.sessionAvailability = dependencies.sessionAvailability ?? defaultSessionAvailability;
    this.log = dependencies.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.shutdownWaitMs = dependencies.shutdownWaitMs ?? SHUTDOWN_WAIT_MS;
  }

  async launch(input: {
    ctx: ExtensionContext;
    name: string;
    options: ResolvedWorkflowRunOptions;
    execute: (ctx: ExtensionContext, options: ResolvedWorkflowRunOptions) => Promise<void>;
  }): Promise<WorkflowLaunchResult> {
    const unavailable = workflowUnavailableResult(input.ctx.mode);
    if (unavailable) return unavailable;
    const runId = createWorkflowRunId();
    const options: ResolvedWorkflowRunOptions = {
      ...input.options, resultViewer: "skip", runId,
      origin: workflowOrigin(input.ctx),
    };
    try {
      await this.start({
        ctx: input.ctx, runId, name: input.name,
        run: async (signal, onStarted) => input.execute({ ...input.ctx, signal }, {
          ...options, signal,
          onRunMetadata(metadata) {
            onStarted();
            return options.onRunMetadata?.(metadata);
          },
        }),
      });
    } catch (error) {
      const message = unknownErrorMessage(error);
      return { content: [{ type: "text", text: `Workflow did not start: ${message}` }], details: { error: "workflow_start_failed", message, runId } };
    }
    return {
      content: [{ type: "text", text: `Workflow "${input.name}" started.\nRun ID: ${runId}` }],
      details: { state: "running", name: input.name, runId },
    };
  }

  private async start(input: WorkflowStartInput): Promise<void> {
    if (this.active.has(input.runId)) throw new Error(`Workflow ${input.runId} is already active.`);

    const sessionId = input.ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    let accepted = false;
    let deliveryScheduled = false;
    let settled = false;
    let startedSignalled = false;
    let resolveStarted: (() => void) | undefined;
    let rejectStarted: ((error: unknown) => void) | undefined;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    const scheduleDelivery = (): void => {
      if (deliveryScheduled || !accepted || !settled || this.shuttingDown.has(sessionId)) return;
      deliveryScheduled = true;
      void this.queueOrDeliver(input.ctx, input.runId).catch((error: unknown) => {
        this.log(`[workflow:${input.runId}] delivery failed: ${unknownErrorMessage(error)}`);
      });
    };

    const settledPromise = (async () => {
      try {
        await input.run(controller.signal, () => {
          if (startedSignalled) return;
          startedSignalled = true;
          resolveStarted?.();
        });
        if (!startedSignalled) rejectStarted?.(new Error("Workflow ended before publishing run metadata."));
      } catch (error) {
        if (!startedSignalled) rejectStarted?.(error);
      } finally {
        settled = true;
        this.active.delete(input.runId);
        await this.notifyRunSettled(input.ctx, input.runId);
        scheduleDelivery();
      }
    })();
    this.active.set(input.runId, {
      controller,
      name: input.name,
      sessionId,
      settled: settledPromise,
      isSettled: () => settled,
    });

    await started;
    const record = await this.storeForCwd(input.ctx.cwd).load(input.runId);
    if (!record?.background || record.background.origin.sessionId !== sessionId) {
      controller.abort(new WorkflowAbortError("Workflow could not persist its origin metadata."));
      throw new Error(`Workflow ${input.runId} did not create a durable run record.`);
    }

    accepted = true;
    scheduleDelivery();
  }

  activeRunIds(ctx: Pick<ExtensionContext, "sessionManager">): ReadonlySet<string> {
    const sessionId = ctx.sessionManager.getSessionId();
    return new Set(
      [...this.active.entries()]
        .filter(([, run]) => run.sessionId === sessionId)
        .map(([runId]) => runId),
    );
  }

  onRunSettled(listener: WorkflowSettledListener): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  async stop(ctx: ExtensionContext, runId: string): Promise<WorkflowRunRecord> {
    const active = this.active.get(runId);
    if (!active || active.sessionId !== ctx.sessionManager.getSessionId()) {
      throw new Error(`Workflow run ${runId} is not active in this session.`);
    }
    active.controller.abort(new WorkflowAbortError("Workflow stopped by user."));
    await waitForRuns([active.settled], this.shutdownWaitMs);
    const store = this.storeForCwd(ctx.cwd);
    if (!active.isSettled()) {
      await forceStoppedRecord(store, runId);
      this.log(`[workflow:${runId}] workflow did not settle after stop; retained state was forced to stopped.`);
    }
    const record = await store.load(runId);
    if (!record) throw new Error(`Workflow run ${runId} was not found after stopping.`);
    if (record.state !== "stopped") throw new Error(`Workflow run ${runId} settled as ${record.state} instead of stopped.`);
    return record;
  }

  async agentSettled(ctx: ExtensionContext): Promise<void> {
    await this.flushPending(ctx);
  }

  async durableRunSettled(ctx: ExtensionContext, runId: string): Promise<void> {
    await this.queueOrDeliver(ctx, runId);
  }

  async sessionStarted(ctx: ExtensionContext): Promise<void> {
    const store = this.storeForCwd(ctx.cwd);
    let records: WorkflowRunRecord[];
    try {
      records = await store.list();
    } catch (error) {
      this.log(`[workflow] recovery could not load run history: ${unknownErrorMessage(error)}`);
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const availability = new Map<string, SessionAvailability>();

    for (const loadedRecord of records) {
      let record = loadedRecord;
      try {
        record = await reconcileInterruptedRun(
          store,
          record,
          sessionId,
          this.active.has(record.runId),
        );
        if (!isPendingOutcome(record)) continue;
        const originSessionId = record.background.origin.sessionId;
        if (originSessionId === sessionId) {
          await this.queueOrDeliver(ctx, record.runId);
          continue;
        }

        let status = availability.get(originSessionId);
        if (!status) {
          status = await this.sessionAvailability(ctx.cwd, originSessionId);
          availability.set(originSessionId, status);
        }
        if (status !== "missing") continue;

        const message = `Originating pi session ${originSessionId} is unavailable; result remains in workflow run history.`;
        await markDelivery(store, record.runId, {
          state: "unavailable",
          attemptedAt: Date.now(),
          message,
        });
        this.log(`[workflow:${record.runId}] ${message}`);
      } catch (error) {
        this.log(`[workflow:${record.runId}] recovery failed: ${unknownErrorMessage(error)}`);
      }
    }
  }

  async sessionShutdown(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    this.shuttingDown.add(sessionId);
    this.pendingDelivery.delete(sessionId);
    const runs = [...this.active.entries()].filter(([, run]) => run.sessionId === sessionId);
    for (const [, run] of runs) {
      run.controller.abort(new WorkflowPauseError());
    }
    await waitForRuns(runs.map(([, run]) => run.settled), this.shutdownWaitMs);
    const store = this.storeForCwd(ctx.cwd);
    for (const [runId, run] of runs) {
      if (run.isSettled()) continue;
      try {
        await forcePausedRecord(store, runId);
        this.log(`[workflow:${runId}] workflow did not settle during shutdown; retained state was forced to paused.`);
      } catch (error) {
        this.log(`[workflow:${runId}] failed to force paused state during shutdown: ${unknownErrorMessage(error)}`);
      }
    }
  }

  private async queueOrDeliver(ctx: ExtensionContext, runId: string): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.shuttingDown.has(sessionId)) return;
    if (ctx.isIdle()) {
      try {
        if (await this.deliver(ctx, runId)) return;
      } catch (error) {
        this.addPending(sessionId, runId);
        throw error;
      }
    }
    this.addPending(sessionId, runId);
    if (ctx.isIdle()) await this.flushPending(ctx);
  }

  private async notifyRunSettled(ctx: ExtensionContext, runId: string): Promise<void> {
    for (const listener of this.settledListeners) {
      try {
        await listener(ctx, runId);
      } catch (error) {
        this.log(`[workflow:${runId}] settlement listener failed: ${unknownErrorMessage(error)}`);
      }
    }
  }

  private async flushPending(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.shuttingDown.has(sessionId)) return;
    const pending = this.pendingDelivery.get(sessionId);
    if (!pending) return;
    for (const runId of pending) {
      try {
        if (await this.deliver(ctx, runId)) pending.delete(runId);
      } catch (error) {
        this.log(`[workflow:${runId}] delivery retry failed: ${unknownErrorMessage(error)}`);
      }
    }
    if (pending.size === 0) this.pendingDelivery.delete(sessionId);
  }

  private addPending(sessionId: string, runId: string): void {
    const pending = this.pendingDelivery.get(sessionId) ?? new Set<string>();
    pending.add(runId);
    this.pendingDelivery.set(sessionId, pending);
  }

  private async deliver(ctx: ExtensionContext, runId: string): Promise<boolean> {
    const store = this.storeForCwd(ctx.cwd);
    const record = await store.load(runId);
    if (!record?.background || record.background.delivery.state !== "pending") return true;
    if (record.background.origin.sessionId !== ctx.sessionManager.getSessionId()) return false;
    if (!isDeliverableState(record.state)) return false;

    if (!sessionHasDelivery(ctx, runId)) {
      const details = workflowCompletionDetails(record);
      this.pi.sendMessage(
        {
          customType: WORKFLOW_DELIVERY_CUSTOM_TYPE,
          content: formatWorkflowDelivery(details),
          display: true,
          details,
        },
        { triggerTurn: false },
      );
    }
    await markDelivery(store, runId, { state: "delivered", deliveredAt: Date.now() });
    return true;
  }
}

export function workflowOrigin(ctx: Pick<ExtensionContext, "sessionManager">, requestedAt = Date.now()): WorkflowOrigin {
  return { sessionId: ctx.sessionManager.getSessionId(), requestedAt };
}

export function workflowCompletionDetails(record: WorkflowRunRecord): WorkflowCompletionDetails {
  if (!isDeliverableState(record.state)) throw new Error(`Workflow run ${record.runId} has not finished or paused.`);
  return {
    name: record.workflow.name,
    result: { summary: workflowSummary(record) },
    completedAt: record.endedAt ?? record.updatedAt,
    usage: record.usage,
    runId: record.runId,
    resumedFromRunId: record.options.resumeFromRunId,
    status: record.state,
  };
}

function workflowSummary(record: WorkflowRunRecord): string {
  if (record.state !== "completed") return boundedSummary(`Workflow ${record.state}: ${record.message}`);
  if (record.result.kind === "unavailable") {
    return boundedSummary(`Workflow completed; retained result is unavailable: ${record.result.reason}`);
  }
  const value = record.result.value;
  if (typeof value === "string") return boundedSummary(value);
  if (isRecord(value) && typeof value.summary === "string") return boundedSummary(value.summary);
  return "Workflow completed. Open run history for the retained result.";
}

function formatWorkflowDelivery(details: WorkflowCompletionDetails): string {
  return [
    `## Workflow: ${details.name}`,
    "",
    `Run ID: ${details.runId}`,
    `State: ${details.status}`,
    "",
    details.result.summary,
  ].join("\n");
}

function sessionHasDelivery(ctx: ExtensionContext, runId: string): boolean {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "custom") continue;
    if (entry.message.customType !== WORKFLOW_DELIVERY_CUSTOM_TYPE) continue;
    const details = entry.message.details;
    if (isRecord(details) && details.runId === runId) return true;
  }
  return false;
}

function isPendingOutcome(record: WorkflowRunRecord): record is WorkflowRunRecord & { readonly background: NonNullable<WorkflowRunRecord["background"]> } {
  return record.background?.delivery.state === "pending" && isDeliverableState(record.state);
}

function isDeliverableState(state: WorkflowRunState): state is "completed" | "failed" | "stopped" | "paused" {
  return state === "completed" || state === "failed" || state === "stopped" || state === "paused";
}

async function markDelivery(
  store: WorkflowRunStore,
  runId: string,
  delivery: Parameters<typeof updateWorkflowRunDelivery>[1],
): Promise<void> {
  const latest = await store.load(runId);
  if (!latest?.background || latest.background.delivery.state !== "pending") return;
  await store.save(updateWorkflowRunDelivery(latest, delivery));
}

async function forcePausedRecord(store: WorkflowRunStore, runId: string): Promise<void> {
  const record = await store.load(runId);
  if (!record || (record.state !== "queued" && record.state !== "running")) return;
  await store.save(transitionWorkflowRun(record, {
    state: "paused",
    progress: record.progress,
    message: "Workflow paused because its host session shut down",
  }));
}

async function forceStoppedRecord(store: WorkflowRunStore, runId: string): Promise<void> {
  const record = await store.load(runId);
  if (!record || (record.state !== "queued" && record.state !== "running")) return;
  await store.save(transitionWorkflowRun(record, {
    state: "stopped",
    progress: record.progress,
    usage: record.usage ?? record.progress.usage ?? {
      agents: [],
      totals: emptyWorkflowUsageTotals(),
      assistantMessages: 0,
    },
    error: new WorkflowAbortError("Workflow stopped by user."),
  }));
}

async function reconcileInterruptedRun(
  store: WorkflowRunStore,
  record: WorkflowRunRecord,
  sessionId: string,
  active: boolean,
): Promise<WorkflowRunRecord> {
  if (
    active
    || record.background?.delivery.state !== "pending"
    || record.background.origin.sessionId !== sessionId
    || (record.state !== "queued" && record.state !== "running")
  ) {
    return record;
  }
  const paused = transitionWorkflowRun(record, {
    state: "paused",
    progress: record.progress,
    message: "Workflow paused because its host process ended before completion",
  });
  await store.save(paused);
  return paused;
}

async function defaultSessionAvailability(cwd: string, sessionId: string): Promise<SessionAvailability> {
  try {
    const sessions = await SessionManager.list(cwd);
    return sessions.some((session) => session.id === sessionId) ? "available" : "missing";
  } catch {
    return "unknown";
  }
}

async function waitForRuns(runs: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  if (runs.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(runs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedSummary(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
