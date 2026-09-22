import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Tool,
  type ToolChoice,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { stableUuid } from "./client.ts";
import { convertMessages, sanitizeSurrogates, type Content, type Part } from "./convert.ts";
import { runtimeModelId, thinkingConfig } from "./models.ts";
import { bridgeSchema, selfContainedSchema } from "./schema.ts";

/**
 * Builds a Gemini `streamGenerateContent` request.
 *
 * Inside the envelope the body is ordinary Gemini, converted the way pi's
 * own Google adapter converts it (see convert.ts). What is added here is only
 * what this backend demands beyond the public Gemini API: the runtime model
 * id, its thinking budget, the Claude/GPT-OSS schema bridge, a few
 * conversation-shape repairs it enforces, and the agent envelope it expects.
 */

export type { Content, Part };

export interface RequestOptions {
  /** Level after pi's clamp; undefined means thinking off. */
  reasoning?: ModelThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  toolChoice?: ToolChoice | "any";
  sessionId?: string;
}

export interface GeminiRequest {
  project: string;
  model: string;
  request: Record<string, unknown>;
  requestType: "agent";
  userAgent: "antigravity";
  requestId: string;
}

/** The only text this module ever adds to a conversation; see {@link repairContents}. */
export const CONTINUE_TEXT = "Continue the active task using the available instructions and context.";

const isText = (part: Part) => typeof part.text === "string" && part.text.trim().length > 0 && !part.thought;
const hasFunctionCall = (turn: Content) => turn.parts.some((part) => part.functionCall);

/** Gemini 3+ rejects a replayed function call that lacks its thought signature. */
export function requiresThoughtSignatures(runtimeId: string): boolean {
  if (!runtimeId.startsWith("gemini-")) return false;
  const major = /^gemini-(\d+)/.exec(runtimeId)?.[1];
  // Unversioned agent runtimes (`gemini-pro-agent`) are current-generation.
  return major === undefined || Number(major) >= 3;
}

/** Claude and GPT-OSS are served through the custom-tool bridge. */
export function usesToolBridge(runtimeId: string): boolean {
  return runtimeId.startsWith("claude-") || runtimeId.startsWith("gpt-oss-");
}

function observationText(name: string, args: Record<string, unknown> | undefined, response: Part["functionResponse"]): string {
  const argsText = args && Object.keys(args).length > 0 ? ` (${JSON.stringify(args)})` : "";
  const payload = response?.response ?? {};
  const failed = "error" in payload;
  const value = failed ? payload.error : "output" in payload ? payload.output : payload;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return `[${failed ? "Failed observation" : "Observation"} from \`${name}\`${argsText}:\n${body}]`;
}

/**
 * History from another model carries tool calls without this model's thought
 * signature, which Gemini 3 rejects outright. Such a call and its result are
 * replayed as plain text instead, so the model keeps what happened without an
 * unverifiable call in its own voice. Gemini only checks the first call of a
 * turn, so a signed first call keeps the whole turn intact.
 */
function observeUnsignedCalls(contents: Content[]): Content[] {
  const pending = new Map<string, { name: string; args?: Record<string, unknown> }>();
  const keyOf = (call: { id?: string; name?: string }) => call.id || `name:${call.name ?? ""}`;

  return contents.map((turn) => {
    if (turn.role === "model") {
      const calls = turn.parts.filter((part) => part.functionCall);
      if (calls.length === 0 || calls[0].thoughtSignature) return turn;
      for (const { functionCall } of calls) {
        pending.set(keyOf(functionCall!), { name: functionCall!.name ?? "tool", args: functionCall!.args });
      }
      return { ...turn, parts: turn.parts.filter((part) => !part.functionCall) };
    }
    if (pending.size === 0) return turn;
    return {
      ...turn,
      parts: turn.parts.flatMap((part): Part[] => {
        const response = part.functionResponse;
        const call = response && pending.get(keyOf(response));
        if (!response || !call) return [part];
        pending.delete(keyOf(response));
        return [{ text: sanitizeSurrogates(observationText(call.name, call.args, response)) }, ...(response.parts ?? [])];
      }),
    };
  });
}

/** Adjacent turns with the same role become one; empty turns disappear. */
function mergeTurns(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const turn of contents) {
    if (turn.parts.length === 0) continue;
    const last = merged.at(-1);
    if (last?.role === turn.role) last.parts.push(...turn.parts);
    else merged.push({ role: turn.role, parts: [...turn.parts] });
  }
  return merged;
}

/**
 * Conversation shapes the public Gemini API tolerates but this backend
 * rejects with a 400. Compaction and model switches produce every one of
 * them, so they are repaired rather than surfaced:
 *
 *   - an unsigned tool call on Gemini 3 (see {@link observeUnsignedCalls});
 *   - a conversation that does not open with a user turn;
 *   - no natural-language user text anywhere, e.g. a tool-only continuation;
 *   - a request that ends on a model turn.
 */
export function repairContents(contents: Content[], requireSignatures: boolean): Content[] {
  const turns = mergeTurns(requireSignatures ? observeUnsignedCalls(contents) : contents);
  const bridge = (): Part => ({ text: CONTINUE_TEXT });

  if (turns.length === 0 || turns[0].role === "model") turns.unshift({ role: "user", parts: [bridge()] });

  if (!turns.some((turn) => turn.role === "user" && turn.parts.some(isText))) {
    turns.find((turn) => turn.role === "user")!.parts.push(bridge());
  }

  const last = turns.at(-1)!;
  if (last.role === "model") {
    if (hasFunctionCall(last)) throw new Error("Gemini request ends on a tool call with no result.");
    turns.push({ role: "user", parts: [bridge()] });
  }
  return turns;
}

function toolDeclarations(tools: Tool[], bridge: boolean) {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(bridge
        ? { parameters: bridgeSchema(tool.parameters) }
        : { parametersJsonSchema: selfContainedSchema(tool.parameters) }),
    })),
  }];
}

/** pi's tool choice as Gemini's calling mode; omitted unless asked, as pi does. */
function callingMode(toolChoice: RequestOptions["toolChoice"]): string | undefined {
  if (toolChoice === "none") return "NONE";
  if (toolChoice === "any") return "ANY";
  return toolChoice ? "AUTO" : undefined;
}

/** Random signed 64-bit decimal, the shape the Antigravity CLI uses for session ids. */
function randomSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigInt64(0, true).toString();
}

/**
 * The agent envelope the Antigravity CLI sends. Ids are derived from the pi
 * session, so one conversation keeps one trajectory across requests and
 * restarts without any state held here.
 */
function envelope(context: TranscriptContext, contents: Content[], runtimeId: string, sessionId?: string) {
  const first = context.messages[0];
  const seed = sessionId ?? (first ? `${first.role}:${first.timestamp ?? ""}` : crypto.randomUUID());
  const conversationId = stableUuid(`antigravity:conv:${seed}`);
  const trajectoryId = stableUuid(`antigravity:traj:${seed}`);
  const step = Math.max(1, contents.length);
  const turn = context.messages.filter((message) =>
    message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted").length;
  const claude = String(runtimeId.startsWith("claude-"));

  return {
    sessionId: sessionId ?? randomSessionId(),
    requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
    labels: {
      last_step_index: String(step - 1),
      request_id: `${trajectoryId}-${turn}`,
      trajectory_id: trajectoryId,
      used_claude: claude,
      used_claude_conservative: claude,
      used_non_gemini_model: String(!runtimeId.startsWith("gemini-")),
    },
  };
}

export function buildRequest(
  model: Model<Api>,
  context: TranscriptContext,
  projectId: string,
  options: RequestOptions = {},
): GeminiRequest {
  const runtimeId = runtimeModelId(model, options.reasoning);
  const contents = repairContents(convertMessages(model, context), requiresThoughtSignatures(runtimeId));

  // The system prompt and tools live in the transcript's system messages,
  // never on the context object; reading them any other way sends neither.
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages);
  // Strict tool sampling (Gemini's VALIDATED mode) is not offered by this backend.
  const mode = tools.length > 0 ? callingMode(options.toolChoice) : undefined;

  const thinking = thinkingConfig(runtimeId, options.reasoning);
  const generationConfig = {
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    maxOutputTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
    ...(thinking && { thinkingConfig: thinking }),
  };

  const { sessionId, requestId, labels } = envelope(context, contents, runtimeId, options.sessionId);

  return {
    project: projectId,
    model: runtimeId,
    request: {
      contents,
      ...(systemPrompt && { systemInstruction: { role: "user", parts: [{ text: sanitizeSurrogates(systemPrompt) }] } }),
      generationConfig,
      ...(tools.length > 0 && { tools: toolDeclarations(tools, usesToolBridge(runtimeId)) }),
      ...(mode !== undefined && { toolConfig: { functionCallingConfig: { mode } } }),
      sessionId,
      labels,
    },
    requestType: "agent",
    userAgent: "antigravity",
    requestId,
  };
}
