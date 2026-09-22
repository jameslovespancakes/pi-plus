// Only pi-ai's package root: it is one of the entry points pi supplies to
// extensions from its own copy. Deep imports have nothing to resolve against
// on a clean install (see convert.ts).
import {
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  formatThrownValue,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StopReason,
  type StreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolChoice,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { geminiHeaders, endpointsFor } from "./client.ts";
import type { Part } from "./convert.ts";
import { decodeApiKey } from "./credentials.ts";
import { GEMINI_API, runtimeModelId } from "./models.ts";
import { buildRequest } from "./request.ts";

/**
 * Gemini streaming transport.
 *
 * The request is Gemini inside an agent envelope, posted to
 * `v1internal:streamGenerateContent`, and every SSE frame comes back wrapped
 * in `.response`. Retrying is pi's: its session retries on the wording
 * below. What is here is what this backend needs beyond that — endpoint fallback, reading quota walls out of the
 * response body, and a watchdog for streams that go silent.
 */

export interface GeminiStreamOptions extends StreamOptions {
  /** Level after pi's clamp; undefined means thinking off. */
  reasoning?: ModelThinkingLevel;
  toolChoice?: ToolChoice | "any";
}

/** Worth trying the next endpoint: capacity and rollout differ between them. */
const ENDPOINT_FALLBACK_STATUS = new Set([403, 404, 429, 500, 502, 503, 504]);

/**
 * Defaults when pi passes no `timeoutMs`, which pi defines as covering both
 * the response and stream idleness. The header deadline catches a warm socket
 * that never answers; a healthy stream emits continuously, so the idle
 * deadline catches one that went silent after its headers.
 */
const HEADER_TIMEOUT_MS = 180_000;
const STALL_TIMEOUT_MS = 120_000;

/**
 * The endpoint occasionally ends a stream having emitted nothing. An empty
 * assistant message stalls the agent loop, so a couple of replays is the
 * difference between "works" and "randomly does nothing".
 */
const MAX_EMPTY_STREAM_REPLAYS = 2;
const EMPTY_STREAM_BACKOFF_MS = 500;

let toolCallCounter = 0;

interface Chunk {
  error?: { message?: string };
  response?: ChunkBody;
}

interface ChunkBody {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  responseId?: string;
}

// --- Failure classification ----------------------------------------------

export interface Failure {
  message: string;
  /** An account-level limit that will not clear by retrying soon. */
  quotaWall: boolean;
  /** Server-stated delay, from the body: Google does not send `retry-after`. */
  retryAfterSeconds?: number;
}

function backendMessage(body: string): { text: string; retryDelay?: number } {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; details?: { retryDelay?: unknown }[] } };
    const text = typeof parsed.error?.message === "string" ? parsed.error.message : body;
    const delay = parsed.error?.details?.map((detail) => detail?.retryDelay).find((value) => typeof value === "string");
    const seconds = typeof delay === "string" ? Number.parseFloat(delay) : Number.NaN;
    return { text, ...(Number.isFinite(seconds) && { retryDelay: Math.ceil(seconds) }) };
  } catch {
    return { text: body };
  }
}

/** "2h5m30s", "3 hours", "45m" → seconds. */
export function parseDuration(text: string): number | undefined {
  let seconds = 0;
  let matched = false;
  for (const [pattern, unit] of [[/(\d+)\s*d/i, 86_400], [/(\d+)\s*h/i, 3_600], [/(\d+)\s*m(?!s)/i, 60], [/(\d+)\s*s/i, 1]] as const) {
    const value = pattern.exec(text)?.[1];
    if (value) { seconds += Number(value) * unit; matched = true; }
  }
  return matched ? seconds : undefined;
}

/**
 * Turns a failed response into an actionable message.
 *
 * The wording is load-bearing: pi retries errors that mention `429` or a 5xx
 * status and never retries `quota exceeded`. A quota wall is therefore
 * phrased as exhaustion, and transient throttling as a rate limit, so pi's
 * own retry policy makes the right call for each.
 */
export function describeFailure(status: number, body: string, runtimeId: string): Failure {
  const { text, retryDelay } = backendMessage(body);
  const detail = text.trim().replace(/\s+/g, " ").slice(0, 400) || "no details";

  if (status === 429) {
    const reset = /Resets? in ([^.\n"]+)/i.exec(text)?.[1]?.trim();
    const quotaWall = /Individual quota reached/i.test(text)
      || reset !== undefined
      || (!/rate.?limit/i.test(text) && /quota exceeded|exceeded your|limit reached|reached your|daily limit/i.test(text));
    const retryAfterSeconds = retryDelay ?? (reset ? parseDuration(reset) : undefined);
    return quotaWall
      ? {
          quotaWall,
          retryAfterSeconds,
          message: `Gemini quota exceeded for this account (429)${reset ? `; resets in ${reset}` : ""}.`
            + " Switch models, add an account with /accounts add gemini, or wait for the reset.",
        }
      : { quotaWall, retryAfterSeconds, message: `Gemini rate limited this request (429): ${detail}` };
  }

  const message = (() => {
    switch (status) {
      case 400:
        return /Invalid JSON payload|Unknown name/i.test(text)
          ? `Gemini rejected the request format (400): ${detail}`
          : `Gemini rejected the request (400): ${detail}`;
      case 401:
        return "Gemini authentication failed (401). Run /login gemini, or /accounts reauth for a pooled account.";
      case 403:
        return `Gemini denied access for this account (403): ${detail}`;
      case 404:
        return /Requested entity was not found/i.test(text)
          ? `Gemini does not serve ${runtimeId} to this account (404). Pick another model with /model.`
          : `Gemini could not find the requested resource (404): ${detail}`;
      case 503:
        return /No capacity available/i.test(text)
          ? `Gemini has no capacity for ${runtimeId} right now (503). Retry shortly or switch models.`
          : `Gemini is temporarily unavailable (503): ${detail}`;
      default:
        return `Gemini request failed (${status}): ${detail}`;
    }
  })();
  return { message, quotaWall: false, ...(retryDelay !== undefined && { retryAfterSeconds: retryDelay }) };
}

/**
 * Response headers plus the retry delay the body stated, in the form the
 * account pool reads when it decides how long to hold an account back.
 */
function failureHeaders(headers: Headers, failure: Failure): Headers {
  const next = new Headers(headers);
  if (failure.retryAfterSeconds !== undefined && !next.has("retry-after")) {
    next.set("retry-after", String(failure.retryAfterSeconds));
  }
  return next;
}

function toRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => { record[name] = value; });
  return record;
}

/** pi's header rule: later layers win, and a null value removes the header. */
function mergeHeaders(...layers: Array<Record<string, string | null | undefined> | undefined>): Record<string, string> {
  const merged: Record<string, string | null | undefined> = {};
  for (const layer of layers) Object.assign(merged, layer);
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** "STOP" and "MAX_TOKENS" are successes; every other finish reason is a failure, as in pi. */
function stopReasonOf(finishReason: string): StopReason {
  return finishReason === "STOP" ? "stop" : finishReason === "MAX_TOKENS" ? "length" : "error";
}

/** Some backends send a signature only on a block's first delta; keep it. */
const retainSignature = (existing: string | undefined, incoming: string | undefined) =>
  typeof incoming === "string" && incoming.length > 0 ? incoming : existing;

// --- Transport -------------------------------------------------------------

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * fetch with a response-header deadline. The deadline disarms once headers
 * arrive; a long healthy body is never cut. Caller cancellation stays bound
 * to the body until it is consumed.
 */
async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) return fetchImpl(url, { ...init, signal });
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`Gemini timed out: no response headers within ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  try {
    return await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
  } catch (error) {
    throw deadline.signal.aborted && !signal?.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

/** A read that fails instead of hanging when the stream goes silent. */
async function readWithin<T>(read: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Gemini stream timed out: no data for ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([read, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Tool-call ids must be `[A-Za-z0-9_-]{1,64}` to replay on Claude; blanks and repeats get a fresh one. */
function toolCallId(provided: string | undefined, name: string, taken: (id: string) => boolean): string {
  const cleaned = (provided ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned && !taken(cleaned) ? cleaned : `${name || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

export const stream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: GeminiStreamOptions,
): AssistantMessageEventStream => {
  const events = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: GEMINI_API,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const { token, projectId } = decodeApiKey(options?.apiKey);
      const runtimeId = runtimeModelId(model, options?.reasoning);

      let body: unknown = buildRequest(model, context, projectId, options);
      body = (await options?.onPayload?.(body, model)) ?? body;
      const payload = JSON.stringify(body);

      const headers = mergeHeaders(geminiHeaders(token), model.headers, options?.headers);
      const fetchImpl = options?.fetch ?? globalThis.fetch;
      const headerTimeout = options?.timeoutMs ?? HEADER_TIMEOUT_MS;
      const idleTimeout = options?.timeoutMs ?? STALL_TIMEOUT_MS;

      /**
       * One attempt across every endpoint. Only the response acted on is
       * reported to `onResponse`: an endpoint that fell through is an internal
       * detail, and reporting its 429 would mark an account that then served
       * the request as exhausted.
       */
      const send = async (): Promise<Response> => {
        let failed: { status: number; headers: Headers; failure: Failure } | undefined;
        for (const endpoint of endpointsFor(model.baseUrl)) {
          options?.signal?.throwIfAborted();
          const response = await fetchWithDeadline(
            fetchImpl,
            `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
            { method: "POST", headers, body: payload },
            options?.signal,
            headerTimeout,
          );
          if (response.ok) {
            await options?.onResponse?.({ status: response.status, headers: toRecord(response.headers) }, model);
            return response;
          }
          const failure = describeFailure(response.status, await response.text(), runtimeId);
          failed = { status: response.status, headers: failureHeaders(response.headers, failure), failure };
          if (failure.quotaWall || !ENDPOINT_FALLBACK_STATUS.has(response.status)) break;
        }

        const { status, headers: reported, failure } = failed!;
        // Reported with the body's reset time, so the account pool can hold a
        // quota-walled account out of routing until it actually resets.
        await options?.onResponse?.({ status, headers: toRecord(reported) }, model);
        // The shape pi's retry policy reads: `status` plus `Headers`.
        throw Object.assign(new Error(failure.message), { status, headers: reported });
      };

      let started = false;
      const ensureStarted = () => {
        if (started) return;
        events.push({ type: "start", partial: output });
        started = true;
      };

      const index = () => output.content.length - 1;
      const closeBlock = (block: TextContent | ThinkingContent | null) => {
        if (!block) return;
        if (block.type === "text") {
          events.push({ type: "text_end", contentIndex: index(), content: block.text, partial: output });
        } else {
          events.push({ type: "thinking_end", contentIndex: index(), content: block.thinking, partial: output });
        }
      };

      const consume = async (response: Response): Promise<boolean> => {
        if (!response.body) throw new Error("Gemini returned no response body.");

        let received = false;
        let block: TextContent | ThinkingContent | null = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const abort = () => void reader.cancel().catch(() => undefined);
        options?.signal?.addEventListener("abort", abort);
        let buffer = "";

        const handle = (chunk: Chunk) => {
          if (chunk.error) throw new Error(`Gemini stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
          const data = chunk.response ?? (chunk as ChunkBody);
          output.responseId ||= data.responseId;

          const candidate = data.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (part.text !== undefined) {
              received = true;
              const thinking = part.thought === true;
              if (!block || (thinking ? block.type !== "thinking" : block.type !== "text")) {
                closeBlock(block);
                block = thinking
                  ? { type: "thinking", thinking: "", thinkingSignature: undefined }
                  : { type: "text", text: "" };
                output.content.push(block);
                ensureStarted();
                events.push({ type: thinking ? "thinking_start" : "text_start", contentIndex: index(), partial: output });
              }

              if (block.type === "thinking") {
                block.thinking += part.text;
                block.thinkingSignature = retainSignature(block.thinkingSignature, part.thoughtSignature);
                events.push({ type: "thinking_delta", contentIndex: index(), delta: part.text, partial: output });
              } else {
                block.text += part.text;
                block.textSignature = retainSignature(block.textSignature, part.thoughtSignature);
                events.push({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
              }
            }

            if (part.functionCall) {
              received = true;
              closeBlock(block);
              block = null;

              const name = part.functionCall.name ?? "";
              const toolCall: ToolCall = {
                type: "toolCall",
                id: toolCallId(part.functionCall.id, name, (id) =>
                  output.content.some((item) => item.type === "toolCall" && item.id === id)),
                name,
                arguments: (part.functionCall.args ?? {}) as ToolCall["arguments"],
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
              };

              output.content.push(toolCall);
              ensureStarted();
              events.push({ type: "toolcall_start", contentIndex: index(), partial: output });
              events.push({ type: "toolcall_delta", contentIndex: index(), delta: JSON.stringify(toolCall.arguments), partial: output });
              events.push({ type: "toolcall_end", contentIndex: index(), toolCall, partial: output });
            }
          }

          if (candidate?.finishReason) {
            output.rawStopReason = candidate.finishReason;
            output.stopReason = output.content.some((item) => item.type === "toolCall")
              ? "toolUse"
              : stopReasonOf(candidate.finishReason);
          }

          const usage = data.usageMetadata;
          if (usage) {
            const cacheRead = usage.cachedContentTokenCount ?? 0;
            const reasoning = usage.thoughtsTokenCount ?? 0;
            output.usage = {
              // promptTokenCount already includes the cached tokens.
              input: (usage.promptTokenCount ?? 0) - cacheRead,
              output: (usage.candidatesTokenCount ?? 0) + reasoning,
              reasoning,
              cacheRead,
              cacheWrite: 0,
              totalTokens: usage.totalTokenCount ?? 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            calculateCost(model, output.usage);
          }
        };

        try {
          for (;;) {
            options?.signal?.throwIfAborted();
            const { done, value } = await readWithin(reader.read(), idleTimeout);
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const json = line.slice(5).trim();
              if (!json || json === "[DONE]") continue;
              let chunk: Chunk;
              try {
                chunk = JSON.parse(json) as Chunk;
              } catch {
                continue; // A partial frame; the next read completes it.
              }
              handle(chunk);
            }
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          options?.signal?.removeEventListener("abort", abort);
        }

        closeBlock(block);
        return received;
      };

      let received = false;
      for (let attempt = 0; attempt <= MAX_EMPTY_STREAM_REPLAYS && !received; attempt++) {
        if (attempt > 0) {
          await pause(EMPTY_STREAM_BACKOFF_MS * 2 ** (attempt - 1), options?.signal);
          // Reset rather than append: the replay restates the whole message.
          output.content = [];
          output.usage = emptyUsage();
          output.stopReason = "stop";
          output.rawStopReason = undefined;
          started = false;
        }
        received = await consume(await send());
      }

      if (!received) throw new Error("Gemini returned an empty response.");
      options?.signal?.throwIfAborted();
      // A terminal stop reason inside a 200 response is still a failure, and
      // the `done` event cannot carry one.
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(`Gemini stopped the response: ${output.rawStopReason ?? "unknown reason"}.`);
      }

      ensureStarted();
      events.push({
        type: "done",
        reason: output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">,
        message: output,
      });
      events.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatThrownValue(error);
      events.push({ type: "error", reason: output.stopReason, error: output });
      events.end();
    }
  })();

  return events;
};

/** Headroom pi leaves between the estimated context and the window. */
const CONTEXT_SAFETY_TOKENS = 4096;

/**
 * The context already used: the last response's reported usage, plus about
 * four characters per token for anything after it. The same estimate pi uses
 * to keep an output ceiling from pushing a request past the context window.
 */
function estimateContextTokens(context: TranscriptContext): number {
  const messages = context.messages;
  let index = messages.length - 1;
  while (index >= 0 && !(messages[index].role === "assistant" && (messages[index] as AssistantMessage).usage?.totalTokens)) index--;
  const usage = index >= 0 ? (messages[index] as AssistantMessage).usage : undefined;
  const counted = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
  const trailing = messages.slice(index + 1).reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  return counted + Math.ceil(trailing / 4);
}

export const streamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const level = options?.reasoning && model.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const requested = options?.maxTokens ?? model.maxTokens;
  const room = model.contextWindow - estimateContextTokens(context) - CONTEXT_SAFETY_TOKENS;
  return stream(model, context, {
    ...options,
    maxTokens: model.contextWindow > 0 ? Math.min(requested, Math.max(1, room)) : requested,
    toolChoice: options?.toolChoice,
    reasoning: level === "off" ? undefined : level,
  });
};

export function geminiApi(): ProviderStreams {
  return { stream, streamSimple };
}
