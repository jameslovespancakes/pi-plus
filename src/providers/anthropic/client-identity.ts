import { createHash, randomUUID } from "node:crypto";
import { xxhash64 } from "./xxhash64.ts";

/**
 * Emulates Claude Code so OAuth requests use plan limits instead of extra usage.
 * This may conflict with Anthropic's stated intent; remove this identity from
 * the provider to opt out. Adapted from @cortexkit/anthropic-auth-core.
 */

/** Pinned to the Claude Code release being imitated. */
export const CLAUDE_CODE_VERSION = "2.1.290";

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
 * Returns the input unchanged when no billing header is present, so this is a
 * no-op for non-Anthropic traffic.
 */
export async function signRequestBody(bodyString: string): Promise<string> {
  if (!CCH_SIGNED.test(bodyString)) return bodyString;

  const unsigned = bodyString.replace(CCH_SIGNED, `$1${CCH_PLACEHOLDER}`);
  const bytes = canonicalBodyBytes(new TextEncoder().encode(unsigned));
  const token = ((await xxhash64(bytes, CCH_SEED)) & 0xfffffn).toString(16).padStart(5, "0");
  return unsigned.replace(CCH_UNSIGNED, `$1cch=${token};`);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const MODEL_KEY = utf8('"model":"');
const FALLBACKS_KEY = utf8('"fallbacks":[');
const CREDIT_KEY = utf8('"fallback_credit_token":"');
const MAX_TOKENS_KEY = utf8('"max_tokens":');
const QUOTE = 0x22, COMMA = 0x2c, BACKSLASH = 0x5c, OPEN = 0x5b, CLOSE = 0x5d;

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

type Range = { start: number; end: number };

/** A matched member also absorbs one adjoining comma: the trailing one, else the leading one. */
function withComma(b: Uint8Array, from: number, start: number, end: number): Range {
  if (end < b.length && b[end] === COMMA) return { start, end: end + 1 };
  if (start > from && b[start - 1] === COMMA) return { start: start - 1, end };
  return { start, end };
}

/**
 * Earliest `fallbacks`, `fallback_credit_token` or `max_tokens` member at or
 * after `from`, which Claude Code leaves out of the checksum.
 */
function excludedMember(b: Uint8Array, from: number): Range | undefined {
  let best: Range | undefined;
  const take = (r: Range) => { if (!best || r.start < best.start) best = r; };

  const f = indexOf(b, FALLBACKS_KEY, from);
  if (f >= 0) {
    let depth = 1, inString = false;
    for (let i = f + FALLBACKS_KEY.length; i < b.length; i++) {
      const c = b[i];
      if (inString) {
        if (c === BACKSLASH) i++;
        else if (c === QUOTE) inString = false;
      } else if (c === QUOTE) inString = true;
      else if (c === OPEN) depth++;
      else if (c === CLOSE && --depth === 0) { take(withComma(b, from, f, i + 1)); break; }
    }
  }

  const t = indexOf(b, CREDIT_KEY, from);
  if (t >= 0) {
    const close = b.indexOf(QUOTE, t + CREDIT_KEY.length);
    if (close >= 0) take(withComma(b, from, t, close + 1));
  }

  for (let p = from; ;) {
    const m = indexOf(b, MAX_TOKENS_KEY, p);
    const digits = m + MAX_TOKENS_KEY.length;
    if (m < 0 || digits >= b.length) break;
    let d = digits;
    while (d < b.length && b[d] >= 0x30 && b[d] <= 0x39) d++;
    if (d === digits) { p = digits; continue; }
    take(withComma(b, from, m, d));
    break;
  }
  return best;
}

/**
 * The bytes Claude Code hashes for `cch`. It works on the raw body, not
 * parsed JSON: every `"model":"…"` value anywhere in the body is blanked
 * (including tool definitions), and `max_tokens`, `fallbacks` and
 * `fallback_credit_token` members are removed together with one comma.
 * Mirrors the native signer in Claude Code 2.1.290.
 */
export function canonicalBodyBytes(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  let member = excludedMember(b, 0);
  for (;;) {
    const model = indexOf(b, MODEL_KEY, pos);
    if (member && (model < 0 || member.start < model)) {
      parts.push(b.subarray(pos, member.start));
      pos = member.end;
      member = excludedMember(b, pos);
      continue;
    }
    const value = model + MODEL_KEY.length;
    const close = model < 0 ? -1 : b.indexOf(QUOTE, value);
    if (close < 0) break;
    parts.push(b.subarray(pos, value));
    pos = close;
  }
  parts.push(b.subarray(pos));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
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
/**
 * Betas this identity adds, on top of whatever pi computed for the model.
 *
 * These must be *merged*, never substituted. pi enables model-specific betas
 * that authorise fields it also emits — `mid-conversation-output-config-…`
 * covers the `output_config` system messages it inserts for adaptive-effort
 * models. Replacing the list leaves those messages in the body with nothing
 * permitting them, and Anthropic rejects the request:
 *
 *     messages.1.output_config: Extra inputs are not permitted
 *
 * which is a 400 on every Opus 5 request and reads like a pi bug.
 */
export function identityBetas(body?: unknown, existing: readonly string[] = []): string[] {
  return [...new Set([...existing.map((beta) => beta.trim()).filter(Boolean), ...selectBetas(body).split(",")])];
}

/**
 * Deliberately omits `anthropic-beta`. pi copies that header verbatim into the
 * request body's `betas`, so setting it here would discard pi's own list; the
 * merge happens per request through {@link identityBetas} instead.
 */
export function clientIdentityHeaders(): Record<string, string> {
  return {
    "user-agent": USER_AGENT,
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
