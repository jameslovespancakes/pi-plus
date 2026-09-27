import {
  createAssistantMessageEventStream, isRetryableAssistantError,
  type Api, type Model, type AssistantMessage, type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { ACCOUNT_RETRY_COOLDOWN_MS, isAccountLimitMessage, parseProviderResetHint } from "./provider-errors.ts";

export const REQUEST_RETRY_DELAYS_MS = [ACCOUNT_RETRY_COOLDOWN_MS, 25_000, 60_000] as const;
const RECOVERY_DIAGNOSTIC = "pi-plus.request-recovery";
export interface RecoveryScheduler {
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}
export const recoveryScheduler: RecoveryScheduler = {
  async sleep(delayMs, signal) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
      const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("Aborted")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  },
};

export type RecoveryReason = "limit" | "auth" | "transient";
export function recoveryReason(message: AssistantMessage): RecoveryReason | undefined {
  if (message.stopReason !== "error") return undefined;
  const text = message.errorMessage ?? "";
  if (isAccountLimitMessage(text)) return "limit";
  if (/\b(?:401|403)\b|invalid_grant|invalid.*refresh|expired.*token/i.test(text)) return "auth";
  return isRetryableAssistantError(message) ? "transient" : undefined;
}

export function recoveryWasPartial(message: { diagnostics?: unknown }): boolean {
  return Array.isArray(message.diagnostics) && message.diagnostics.some((diagnostic) =>
    diagnostic?.type === RECOVERY_DIAGNOSTIC && diagnostic?.details?.partial === true);
}

export interface RecoveryAccount { readonly id: string }
interface RecoveryRequest<T extends RecoveryAccount> {
  model: Model<Api>;
  signal?: AbortSignal;
  /** Re-read routing state each time; never select a blocked or already-tried credential. */
  next(excluded: ReadonlySet<string>): T | undefined | Promise<T | undefined>;
  stream(account: T): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
  classify?(account: T, message: AssistantMessage): RecoveryReason | undefined;
  failed?(account: T, message: AssistantMessage, reason: RecoveryReason): number | undefined | void | Promise<number | undefined | void>;
  scheduler?: RecoveryScheduler;
}

/** Retries only the pending model request, never an agent session or completed tool work. */
export function streamWithRecovery<T extends RecoveryAccount>(request: RecoveryRequest<T>): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    let last: AssistantMessage | undefined;
    let reason: RecoveryReason = "limit";
    let attempts = 0;
    let resetAt: number | undefined;
    try {
      for (let round = 0; round <= REQUEST_RETRY_DELAYS_MS.length; round++) {
        request.signal?.throwIfAborted();
        if (round > 0) await (request.scheduler ?? recoveryScheduler).sleep(REQUEST_RETRY_DELAYS_MS[round - 1], request.signal);
        const excluded = new Set<string>();
        // Defensive bound if a concurrently edited pool keeps adding accounts.
        for (let i = 0; i < 100; i++) {
          request.signal?.throwIfAborted();
          const account = await abortable(Promise.resolve(request.next(excluded)), request.signal);
          if (!account || excluded.has(account.id)) break;
          excluded.add(account.id);
          attempts++;
          let visible = false;
          let terminal = false;
          const pending: AssistantMessageEvent[] = [];
          let failure: AssistantMessage | undefined;
          let partial: AssistantMessage | undefined;
          try {
            const events = await abortable(Promise.resolve(request.stream(account)), request.signal);
            for await (const event of abortableEvents(events, request.signal)) {
              if (event.type === "error") {
                failure = event.error;
                terminal = true;
                break;
              }
              if ("partial" in event) partial = event.partial;
              if (event.type === "start" && !visible) { pending.push(event); continue; }
              visible = true;
              for (const saved of pending.splice(0)) output.push(saved);
              output.push(event);
              if (event.type === "done") { terminal = true; return; }
            }
            if (!terminal) failure = errorMessage(request.model, "Provider stream ended before a terminal response event.");
          } catch (error) {
            failure = errorMessage(request.model, error instanceof Error ? error.message : String(error));
          }
          last = failure!;
          if (visible && partial && last.content.length === 0) last = { ...last, content: partial.content, usage: partial.usage };
          if (request.signal?.aborted || last.stopReason === "aborted") {
            output.push({ type: "error", reason: "aborted", error: { ...last, stopReason: "aborted" } });
            return;
          }
          // A nested provider already owns recovery. Do not multiply its budget.
          const handled = last.diagnostics?.some((diagnostic) => diagnostic.type === RECOVERY_DIAGNOSTIC);
          const retry = request.classify?.(account, last) ?? recoveryReason(last);
          if (retry) {
            reason = retry;
            try {
              const at = await abortable(Promise.resolve(request.failed?.(account, last, retry)), request.signal);
              if (typeof at === "number" && Number.isFinite(at)) resetAt = Math.max(resetAt ?? 0, at);
            } catch { /* Accounting must not replace the provider's failure. */ }
          }
          if (handled || !retry) {
            output.push({ type: "error", reason: "error", error: last });
            return;
          }
          if (visible) {
            output.push({ type: "error", reason: "error", error: terminalFailure(last, reason, attempts, resetAt, true) });
            return;
          }
          // Nothing was exposed: rotate accounts immediately within this round.
        }
      }
      output.push({ type: "error", reason: "error", error: terminalFailure(
        last ?? errorMessage(request.model, "No eligible account is currently available."), reason, attempts, resetAt,
      ) });
    } catch (error) {
      const failed = errorMessage(request.model, error instanceof Error ? error.message : String(error));
      if (request.signal?.aborted) failed.stopReason = "aborted";
      output.push({ type: "error", reason: failed.stopReason === "aborted" ? "aborted" : "error", error: failed });
    } finally { output.end(); }
  })();
  return output;
}

async function* abortableEvents(events: AssistantMessageEventStream, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // The provider already receives the same signal. Do not wait for an uncooperative iterator to close.
    void iterator.return?.().catch(() => {});
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("Aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function terminalFailure(last: AssistantMessage, reason: RecoveryReason, attempts: number, resetAt?: number, partial = false): AssistantMessage {
  const at = resetAt ?? parseProviderResetHint(last.errorMessage ?? "").resetAt;
  // Keep the original error in pi's diagnostics. The terminal summary must not
  // trigger another native retry loop after this request's budget was spent.
  const summary = reason === "limit" ? "Account usage limit reached. No eligible account could complete this request."
    : reason === "auth" ? "No eligible account could authenticate. Reauthorize it with /accounts."
    : "The provider could not complete this request after automatic recovery.";
  return {
    ...last,
    errorMessage: `${summary} ${partial ? "Output had already begun; send a follow-up to continue." : "Automatic attempts have finished."}${at ? ` Resets at ${new Date(at).toISOString()}.` : ""}`,
    diagnostics: [...(last.diagnostics ?? []), {
      type: RECOVERY_DIAGNOSTIC, timestamp: Date.now(),
      error: { message: last.errorMessage ?? "Unknown provider failure" },
      details: { attempts, reason, partial },
    }],
  };
}

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: "error", errorMessage: message, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
