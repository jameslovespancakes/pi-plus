import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** CCR v2 wire shapes, not a second definition of pi's message types. */
export interface RemoteMessage {
  type: string;
  [key: string]: unknown;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function content(block: TextContent | ImageContent): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } };
}

/** Mirror only conversation messages, never system prompts, custom context or credentials. */
export function mirrorMessage(message: AgentMessage): RemoteMessage | undefined {
  switch (message.role) {
    case "user":
      return { type: "user", message: { role: "user", content: typeof message.content === "string"
        ? [{ type: "text", text: message.content }] : message.content.map(content) } };
    case "assistant":
      return {
        type: "assistant",
        message: {
          id: `msg_${randomUUID()}`, role: "assistant", model: message.model,
          content: message.content.map((block) => {
            if (block.type === "toolCall") {
              return { type: "tool_use", id: block.id, name: block.name, input: block.arguments };
            }
            if (block.type === "thinking") {
              return { type: "thinking", thinking: block.thinking, ...(block.thinkingSignature
                ? { signature: block.thinkingSignature } : {}) };
            }
            return { type: "text", text: block.text };
          }),
          stop_reason: message.stopReason === "toolUse" ? "tool_use"
            : message.stopReason === "length" ? "max_tokens" : "end_turn",
        },
      };
    case "toolResult":
      return { type: "user", message: { role: "user", content: [{
        type: "tool_result", tool_use_id: message.toolCallId,
        content: message.content.map(content), is_error: message.isError,
      }] } };
    default:
      return undefined;
  }
}

/** Tool-result echoes must never become new user prompts. Remote input is text-only. */
export function inboundText(payload: Record<string, unknown>): string | undefined {
  if (payload.type !== "user" || !record(payload.message)) return undefined;
  const value = payload.message.content;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (!Array.isArray(value) || value.some((block) => !record(block) || block.type !== "text")) return undefined;
  const text = value.map((block) => typeof block.text === "string" ? block.text : "").join("");
  return text.trim() ? text : undefined;
}

/** Data-only SSE parser. Retains partial frames, including a CRLF split across chunks. */
export function parseSSE(buffer: string): { frames: string[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remaining = parts.pop()!;
  const frames = parts.map((part) => part.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, "")).join("\n")).filter(Boolean);
  return { frames, remaining };
}

export class RecentIds {
  private readonly ids = new Set<string>();
  has(id: string): boolean { return this.ids.has(id); }
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > 1024) this.ids.delete(this.ids.values().next().value!);
  }
}
