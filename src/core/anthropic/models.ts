/**
 * Anthropic model catalogue.
 *
 * These are the models pi's built-in catalogue does not carry (or carries with
 * stale pricing). Extracted so the provider definition lives here rather than
 * in a dependency.
 */

export const FABLE_CONTEXT_WINDOW = 1_000_000;
export const FABLE_MAX_OUTPUT = 128_000;

/** Per-million-token USD. `cacheWrite` is the 5-minute tier. */
export const FABLE_PRICING = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
/** 5.1 halved cache reads. */
export const FABLE_5_1_PRICING = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };

export interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

const textImage: ("text" | "image")[] = ["text", "image"];

const fable = (id: string, name: string, pricing = FABLE_PRICING): ModelSpec => ({
  id, name, reasoning: true, input: textImage, cost: pricing,
  contextWindow: FABLE_CONTEXT_WINDOW, maxTokens: FABLE_MAX_OUTPUT,
});

export const ANTHROPIC_MODELS: ModelSpec[] = [
  fable("claude-fable-5", "Claude Fable 5"),
  fable("claude-mythos-5", "Claude Mythos 5"),
  fable("claude-fable-5-1", "Claude Fable 5.1", FABLE_5_1_PRICING),
  fable("claude-mythos-5-1", "Claude Mythos 5.1", FABLE_5_1_PRICING),
  {
    id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, input: textImage,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000, maxTokens: 128_000,
  },
  {
    id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, input: textImage,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000, maxTokens: 128_000,
  },
  {
    id: "claude-opus-4-5", name: "Claude Opus 4.5", reasoning: true, input: textImage,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200_000, maxTokens: 64_000,
  },
  {
    id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, input: textImage,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000, maxTokens: 128_000,
  },
  {
    id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, input: textImage,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000, maxTokens: 64_000,
  },
  {
    id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, input: textImage,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000, maxTokens: 64_000,
  },
];
