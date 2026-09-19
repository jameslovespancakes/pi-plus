import { createHash, randomUUID } from "node:crypto";
import { xxhash64 } from "./xxhash64.ts";

/**
 * Emulates Claude Code so OAuth requests use plan limits instead of extra usage.
 * This may conflict with Anthropic's stated intent; remove this identity from
 * the provider to opt out. Adapted from @cortexkit/anthropic-auth-core.
 */

/** Pinned to the Claude Code release being imitated. */
export const CLAUDE_CODE_VERSION = "2.1.258";

/** Claude Code checksum constants. They can change between CLI releases. */
const CCH_SEED = 0x4d659218e32a3268n;
const CCH_SALT = "59cf53e54c78";
const CCH_POSITIONS = [4, 7, 20];
const CCH_PLACEHOLDER = "cch=00000;";

const CCH_SIGNED = /("system":\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=[^;"]+; cc_entrypoint=[^;"]+; )cch=[0-9a-f]{5};/;
const CCH_UNSIGNED = /("system":\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=[^;"]+; cc_entrypoint=[^;"]+; )cch=00000;/;

/** Final text block of the first user message; a few characters are sampled. */
export function firstUserText(messages: any[] | undefined): string {
  const message = (messages ?? []).find((m) => m?.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  const texts = message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string");
  const command = texts.find((b: any) => b.text.includes("<command-name>"));
  if (command) return command.text.slice(command.text.indexOf("<command-name>"));
  return texts.at(-1)?.text ?? "";
}

/** Three hex characters appended to cc_version. */
export function ccVersionSuffix(sample: string, version = CLAUDE_CODE_VERSION): string {
  const sampled = CCH_POSITIONS.map((i) => sample[i] ?? "0").join("");
  return createHash("sha256").update(`${CCH_SALT}${sampled}${version}`).digest("hex").slice(0, 3);
}

/** Billing header with a placeholder, ready for `signRequestBody`. */
export function billingHeader(sample: string, entrypoint = "cli", version = CLAUDE_CODE_VERSION): string {
  return `x-anthropic-billing-header: cc_version=${version}.${ccVersionSuffix(sample, version)}; cc_entrypoint=${entrypoint}; ${CCH_PLACEHOLDER}`;
}

/**
 * Fills in the `cch` placeholder of an already-serialised request body.
 *
 * `model` and `max_tokens` are blanked before hashing, matching the official
 * canonicalisation. Returns the input unchanged when no billing header is
 * present, so this is a no-op for non-Anthropic traffic.
 */
export async function signRequestBody(bodyString: string): Promise<string> {
  if (!CCH_SIGNED.test(bodyString)) return bodyString;

  const unsigned = bodyString.replace(CCH_SIGNED, `$1${CCH_PLACEHOLDER}`);
  const canonical = JSON.parse(unsigned);
  canonical.model = "";
  delete canonical.max_tokens;

  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const token = ((await xxhash64(bytes, CCH_SEED)) & 0xfffffn).toString(16).padStart(5, "0");
  return unsigned.replace(CCH_UNSIGNED, `$1cch=${token};`);
}
const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const STAINLESS_PACKAGE_VERSION = "0.112.1";
const STAINLESS_RUNTIME_VERSION = "v26.3.0";

/** Sent when the request carries no tools. */
const BASE_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advisor-tool-2026-03-01",
  "advanced-tool-use-2025-11-20",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
];

/** Sent for a full agent turn: tools, system blocks and thinking together. */
const FULL_AGENT_BETAS = [
  ...BASE_BETAS,
  "claude-code-20250219",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
  "fallback-credit-2026-06-01",
];

function stainlessOS(): string {
  switch (process.platform) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return "Unknown";
  }
}

function stainlessArch(): string {
  switch (process.arch) {
    case "arm64": return "arm64";
    case "x64": return "x64";
    case "ia32": return "x32";
    default: return process.arch;
  }
}

/** One session id per process, matching the real CLI's lifetime. */
let sessionId: string | undefined;
function currentSessionId(): string {
  return (sessionId ??= randomUUID());
}

function hasFullAgentShape(body: any): boolean {
  return Array.isArray(body?.tools) && body.tools.length > 0
    && Array.isArray(body?.system)
    && !!body?.thinking && typeof body.thinking === "object";
}

/** Documentation paragraphs must move from `system` into `messages`. */
const DOCS_ANCHOR = "Pi documentation";

/** Lone surrogates are invalid UTF-8 and are rejected outright. */
function sanitizePrompt(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

/** Splits the system prompt, moving unknown shapes conservatively. */
export function splitSystemPrompt(prompt: string): { systemText?: string; messageText: string } {
  const paragraphs = sanitizePrompt(prompt).split(/\n\n+/);
  const docs = paragraphs.filter((p) => p.includes(DOCS_ANCHOR));
  if (docs.length === 0) return { messageText: sanitizePrompt(prompt) };

  const keep = paragraphs.filter((p) => !p.includes(DOCS_ANCHOR));
  return {
    ...(keep.length ? { systemText: keep.join("\n\n") } : {}),
    messageText: docs.join("\n\n"),
  };
}

/** Prepends a cache-controlled block to the first user message. */
export function prependPromptBlock(messages: any[], text: string): void {
  const firstUser = (messages ?? []).find((m) => m?.role === "user");
  if (!firstUser || !text) return;

  const block = { type: "text", text, cache_control: { type: "ephemeral" } };
  if (typeof firstUser.content === "string") {
    firstUser.content = [block, { type: "text", text: firstUser.content }];
    return;
  }
  if (Array.isArray(firstUser.content)) firstUser.content.unshift(block);
}

export function selectBetas(body: unknown, extra: string[] = []): string {
  const selected = hasFullAgentShape(body) ? [...FULL_AGENT_BETAS] : [...BASE_BETAS];
  for (const beta of extra) {
    const trimmed = beta.trim();
    if (trimmed) selected.push(trimmed);
  }
  return [...new Set(selected)].join(",");
}

/** Headers presenting this client as Claude Code. */
export function clientIdentityHeaders(body?: unknown, existingBetas?: string): Record<string, string> {
  const incoming = (existingBetas ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  return {
    "user-agent": USER_AGENT,
    // Pi copies this header into the request body's betas field.
    "anthropic-beta": selectBetas(body, incoming),
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "x-client-request-id": randomUUID(),
    "x-claude-code-session-id": currentSessionId(),
    "x-stainless-arch": stainlessArch(),
    "x-stainless-lang": "js",
    "x-stainless-os": stainlessOS(),
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": STAINLESS_RUNTIME_VERSION,
    "x-stainless-timeout": "600",
  };
}
