import {
  collapseSystemMessages,
  withoutInitialSystemMessage,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * pi messages → Gemini `contents`.
 *
 * A port of pi-ai's `convertMessages` / `transformMessages` from its Google
 * adapter (MIT). pi does not supply that module to extensions — it hands out
 * only its package root, `compat`, `oauth` and `providers/all`, and installs
 * packages without their peers — so importing it resolves to nothing on a
 * clean install. The behaviour is kept identical to pi's: thought-signature
 * validation, cross-model thinking demoted to text, tool-call id
 * normalisation, synthetic results for orphaned calls, and multimodal
 * function responses. Re-check it against pi's adapter on a pi upgrade.
 */

export interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name?: string; id?: string; response?: Record<string, unknown>; parts?: Part[] };
}

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

/** Unpaired UTF-16 surrogates are rejected by the JSON the API parses. */
export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// Thought signatures must be base64 (TYPE_BYTES); anything else is rejected.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isValidSignature = (signature?: string): signature is string =>
  !!signature && signature.length % 4 === 0 && BASE64.test(signature);

function geminiMajor(modelId: string): number | undefined {
  const match = /^gemini(?:-live)?-(\d+)/i.exec(modelId);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Claude, GPT-OSS and Gemini 3+ need explicit ids on function calls and responses. */
export function requiresToolCallId(modelId: string): boolean {
  const major = geminiMajor(modelId);
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-") || (major !== undefined && major >= 3);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const major = geminiMajor(modelId);
  return major === undefined || major >= 3;
}

const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function withoutImages<T extends { type: string }>(content: T[], placeholder: string): T[] {
  const result: T[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder } as unknown as T);
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = (block as { text?: string }).text === placeholder;
  }
  return result;
}

/**
 * Makes a history replayable on `model`: another model's thinking becomes
 * text, its signatures are dropped, its tool-call ids are normalised, failed
 * turns are skipped, and every tool call is answered.
 */
function transformMessages(messages: Message[], model: Model<Api>, normalizeId: (id: string) => string): Message[] {
  const idMap = new Map<string, string>();
  const vision = model.input.includes("image");

  const transformed = messages.map((raw): Message => {
    const message = (raw.content == null ? { ...raw, content: [] } : raw) as Message;

    if (message.role === "user") {
      return !vision && Array.isArray(message.content)
        ? { ...message, content: withoutImages(message.content, USER_IMAGE_PLACEHOLDER) }
        : message;
    }
    if (message.role === "toolResult") {
      const content = vision ? message.content : withoutImages(message.content, TOOL_IMAGE_PLACEHOLDER);
      const toolCallId = idMap.get(message.toolCallId) ?? message.toolCallId;
      return { ...message, content, toolCallId };
    }
    if (message.role !== "assistant") return message;

    const sameModel = message.provider === model.provider && message.api === model.api && message.model === model.id;
    const content = message.content.flatMap((block): AssistantMessage["content"] => {
      if (block.type === "thinking") {
        if (block.redacted) return sameModel ? [block] : [];
        if (sameModel && block.thinkingSignature) return [block];
        if (!block.thinking || block.thinking.trim() === "") return [];
        return sameModel ? [block] : [{ type: "text", text: block.thinking }];
      }
      if (block.type === "text") return sameModel ? [block] : [{ type: "text", text: block.text }];
      if (block.type === "toolCall" && !sameModel) {
        const { thoughtSignature: _dropped, ...call } = block;
        const id = normalizeId(block.id);
        if (id !== block.id) idMap.set(block.id, id);
        return [{ ...call, id }];
      }
      return [block];
    });
    return { ...message, content };
  });

  // Every tool call needs a result before the next turn; an unanswered one
  // (an interrupted run, a user message mid-tool-flow) gets a synthetic error.
  const result: Message[] = [];
  let pending: { id: string; name: string }[] = [];
  let answered = new Set<string>();
  const closePending = () => {
    for (const call of pending) {
      if (answered.has(call.id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      });
    }
    pending = [];
    answered = new Set();
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      closePending();
      // Incomplete turns are not replayed; the model resumes from the last good state.
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const calls = message.content.filter((block) => block.type === "toolCall");
      if (calls.length > 0) {
        pending = calls.map((call) => ({ id: call.id, name: call.name }));
        answered = new Set();
      }
      result.push(message);
    } else if (message.role === "toolResult") {
      answered.add(message.toolCallId);
      result.push(message);
    } else {
      if (message.role === "user") closePending();
      result.push(message);
    }
  }
  closePending();
  return result;
}

/** Gemini `contents` for a transcript; the system prompt travels separately. */
export function convertMessages(model: Model<Api>, context: TranscriptContext): Content[] {
  // Gemini has no mid-conversation system messages; the prompt is systemInstruction.
  const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
  const includeIds = requiresToolCallId(model.id);
  const normalizeId = (id: string) => includeIds ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id;
  const contents: Content[] = [];

  for (const message of transformMessages(conversation, model, normalizeId)) {
    if (message.role === "user") {
      const parts: Part[] = typeof message.content === "string"
        ? [{ text: sanitizeSurrogates(message.content) }]
        : message.content.map((item) => item.type === "text"
          ? { text: sanitizeSurrogates(item.text) }
          : { inlineData: { mimeType: item.mimeType, data: item.data } });
      if (parts.length > 0) contents.push({ role: "user", parts });
    } else if (message.role === "assistant") {
      const sameModel = message.provider === model.provider && message.model === model.id;
      const signature = (value?: string) => sameModel && isValidSignature(value) ? value : undefined;
      const parts: Part[] = [];

      for (const block of message.content) {
        if (block.type === "text") {
          const thoughtSignature = signature(block.textSignature);
          // An empty part that carries a signature must still be echoed back,
          // or the reasoning chain breaks and turns end with an empty STOP.
          if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
          parts.push({ text: sanitizeSurrogates(block.text), ...(thoughtSignature && { thoughtSignature }) });
        } else if (block.type === "thinking") {
          if (sameModel) {
            const thoughtSignature = signature(block.thinkingSignature);
            if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
            parts.push({ thought: true, text: sanitizeSurrogates(block.thinking), ...(thoughtSignature && { thoughtSignature }) });
          } else if (block.thinking && block.thinking.trim() !== "") {
            parts.push({ text: sanitizeSurrogates(block.thinking) });
          }
        } else if (block.type === "toolCall") {
          const thoughtSignature = signature(block.thoughtSignature);
          parts.push({
            functionCall: { name: block.name, args: block.arguments ?? {}, ...(includeIds && { id: block.id }) },
            ...(thoughtSignature && { thoughtSignature }),
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (message.role === "toolResult") {
      const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const images = model.input.includes("image") ? message.content.filter((item) => item.type === "image") : [];
      const imageParts: Part[] = images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }));
      const nested = imageParts.length > 0 && supportsMultimodalFunctionResponse(model.id);
      const value = text.length > 0 ? sanitizeSurrogates(text) : imageParts.length > 0 ? "(see attached image)" : "";

      const part: Part = {
        functionResponse: {
          name: message.toolName,
          response: message.isError ? { error: value } : { output: value },
          ...(nested && { parts: imageParts }),
          ...(includeIds && { id: message.toolCallId }),
        },
      };
      // Every function response of a turn must share one user turn.
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts.some((existing) => existing.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });

      if (imageParts.length > 0 && !nested) contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
    }
  }
  return contents;
}
