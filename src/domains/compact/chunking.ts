import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ChunkRole, SemanticChunk, SourceItem } from "./types.ts";

export const TARGET_CHUNK_TOKENS = 512;
export const MIN_CHUNK_TOKENS = 128;
export const MAX_CHUNK_TOKENS = 1024;
export const CHUNK_OVERLAP_TOKENS = 32;

const PROTECTION_PATTERN = /(?:\b(?:must|never|required?|constraint|blocked|blocker|decision|correction|instead|uncommitted|rollback|next steps?|todo|in progress|do not|don't|cannot|can't)\b|\b(?:error|failed?|failure|exception|timeout|timed out|denied|refused)\b|\b(?:modified|created|deleted|renamed|implemented|verified|reproduced)\b)/i;
const EXACT_PATTERN = /(?:[A-Za-z]:[\\/][^\s`"']+|(?:^|\s)(?:\.\.?[\\/]|~[\\/])[^\s`"']+|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|cs|cpp|c|h|yaml|yml|toml|lock|sql)\b|`[^`\n]{1,160}`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)|\b(?:exit code|status code|HTTP)\s*[:=]?\s*\d+\b|\b\d+(?:\.\d+)?%\b)/im;
const QUARANTINE_PATTERN = /(?:ignore (?:all )?(?:prior|previous|earlier|system|developer) instructions?|system (?:override|message|prompt)|developer (?:override|message)|you are (?:chatgpt|the assistant)|follow these instructions?|assistant must|reveal (?:the )?(?:system|developer) prompt|include (?:the )?exact token|output (?:only )?(?:the )?(?:token|string)|prompt injection|INJECTION_[A-Z0-9_-]+)/i;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function blockText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[image ${block.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function serializeMessage(message: Message): string {
  if (message.role === "user") return `[User]\n${blockText(message.content)}`;
  if (message.role === "toolResult") {
    const state = message.isError ? " error" : "";
    return `[Tool result: ${message.toolName}${state}]\n${blockText(message.content)}`;
  }
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(`[Assistant]\n${block.text}`);
    else if (block.type === "thinking") parts.push(`[Assistant thinking]\n${block.thinking}`);
    else if (block.type === "toolCall") {
      parts.push(`[Assistant tool call]\n${block.name}(${JSON.stringify(block.arguments)})`);
    }
  }
  if (message.errorMessage) parts.push(`[Assistant error]\n${message.errorMessage}`);
  return parts.join("\n\n");
}

function roleFor(message: AgentMessage, converted: Message): ChunkRole {
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "assistant";
  if (message.role === "toolResult" || message.role === "bashExecution") return "tool";
  if (message.role === "compactionSummary" || message.role === "branchSummary") return "summary";
  if (message.role === "custom") return "custom";
  if (converted.role === "toolResult") return "tool";
  if (converted.role === "assistant") return "assistant";
  return "custom";
}

/** Convert Pi messages without applying Pi's tool-output truncation. */
export function sourceItemsFromMessages(messages: readonly AgentMessage[]): SourceItem[] {
  const items: SourceItem[] = [];
  for (const message of messages) {
    for (const converted of convertToLlm([message])) {
      const text = serializeMessage(converted).trim();
      if (!text) continue;
      items.push({ role: roleFor(message, converted), text, source: "conversation" });
    }
  }
  return items;
}

export function legacySummaryItem(summary: string): SourceItem {
  return { role: "summary", text: `[Legacy compaction summary]\n${summary}`, source: "legacy-summary" };
}

export function isQuarantined(role: ChunkRole, text: string): boolean {
  return role === "tool" && QUARANTINE_PATTERN.test(text);
}

export function isProtected(role: ChunkRole, text: string): boolean {
  if (isQuarantined(role, text)) return false;
  if (role === "user" || role === "summary") return true;
  return PROTECTION_PATTERN.test(text);
}

export function isExactHeavy(text: string): boolean {
  return EXACT_PATTERN.test(text) || PROTECTION_PATTERN.test(text);
}

function splitLargeItem(item: SourceItem): SourceItem[] {
  const maxChars = MAX_CHUNK_TOKENS * 4;
  const overlapChars = CHUNK_OVERLAP_TOKENS * 4;
  if (item.text.length <= maxChars) return [item];

  const pieces: SourceItem[] = [];
  let start = 0;
  while (start < item.text.length) {
    let end = Math.min(item.text.length, start + maxChars);
    if (end < item.text.length) {
      const newline = item.text.lastIndexOf("\n", end);
      const sentence = item.text.lastIndexOf(". ", end);
      const boundary = Math.max(newline, sentence);
      if (boundary > start + Math.floor(maxChars / 2)) end = boundary + 1;
    }
    pieces.push({ ...item, text: item.text.slice(start, end) });
    if (end >= item.text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return pieces;
}

function safetyKey(item: SourceItem): string {
  return [item.role, item.source, isProtected(item.role, item.text), isQuarantined(item.role, item.text)].join(":");
}

function makeChunk(items: readonly SourceItem[]): SemanticChunk {
  const text = items.map((item) => item.text).join("\n\n");
  const role = items[0]!.role;
  const source = items[0]!.source;
  const hash = createHash("sha256").update(role).update("\0").update(source).update("\0").update(text).digest("hex");
  return {
    id: `SC-${hash.slice(0, 16)}`,
    hash,
    role,
    text,
    tokens: estimateTokens(text),
    source,
    protected: isProtected(role, text),
    exactHeavy: isExactHeavy(text),
    quarantined: isQuarantined(role, text),
  };
}

/**
 * Semantic/trust-aware chunking. Role and safety boundaries are never mixed;
 * undersized chunks are retained when combining them would cross a boundary.
 */
export function semanticChunks(sourceItems: readonly SourceItem[]): SemanticChunk[] {
  const units = sourceItems.flatMap(splitLargeItem);
  const chunks: SemanticChunk[] = [];
  let current: SourceItem[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length > 0) chunks.push(makeChunk(current));
    current = [];
    currentTokens = 0;
  };

  for (const unit of units) {
    const unitTokens = estimateTokens(unit.text);
    const compatible = current.length === 0 || safetyKey(current[0]!) === safetyKey(unit);
    const combinedTokens = currentTokens + unitTokens;
    if (!compatible || (current.length > 0 && currentTokens >= MIN_CHUNK_TOKENS && combinedTokens > TARGET_CHUNK_TOKENS)) {
      flush();
    }
    if (current.length > 0 && currentTokens + unitTokens > MAX_CHUNK_TOKENS) flush();
    current.push(unit);
    currentTokens += unitTokens;
    if (currentTokens >= TARGET_CHUNK_TOKENS) flush();
  }
  flush();
  return chunks;
}
