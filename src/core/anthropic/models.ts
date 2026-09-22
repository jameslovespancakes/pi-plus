import type { Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS as PI_ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { cachedAnthropicModels, type LiveModel } from "./catalog.ts";

/**
 * Anthropic model catalogue.
 *
 * Three sources, in increasing authority:
 *
 *   1. pi's bundled catalogue — complete metadata, but generated at build time
 *      and therefore always a little behind Anthropic.
 *   2. the live `/v1/models` list cached by `catalog.ts` — authoritative about
 *      which models exist, silent about their limits.
 *   3. local corrections and additions, for the handful of things pi has
 *      wrong or has never carried.
 *
 * The merge has to be a superset of pi's list.
 * `registerProvider("anthropic", { models })` *substitutes* the catalogue
 * rather than extending it, so anything omitted here vanishes from the picker
 * with no error at all.
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

/** Models neither pi nor the live list carries. */
const ADDITIONS: ModelSpec[] = [
  fable("claude-fable-5", "Claude Fable 5"),
  fable("claude-mythos-5", "Claude Mythos 5"),
  fable("claude-fable-5-1", "Claude Fable 5.1", FABLE_5_1_PRICING),
  fable("claude-mythos-5-1", "Claude Mythos 5.1", FABLE_5_1_PRICING),
];

/**
 * Applied on top of pi's entry for the same id. Only the listed fields change;
 * everything else pi knows (thinking levels, input limits, cache tiers) stays.
 */
const CORRECTIONS: Record<string, Partial<ModelSpec>> = {
  "claude-opus-5": {
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000, maxTokens: 128_000,
  },
  "claude-opus-4-8": {
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000, maxTokens: 128_000,
  },
  "claude-sonnet-5": {
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000, maxTokens: 128_000,
  },
};

type AnthropicModel = Model<"anthropic-messages">;

/** `claude-opus-5-5` -> `opus`; undated ids only, so aliases do not win below. */
function familyOf(id: string): string | undefined {
  return /^claude-([a-z]+)-\d/.exec(id)?.[1];
}

/** `claude-opus-5-5` -> [5, 5]. A dated alias sorts below its undated form. */
function versionOf(id: string): number[] {
  const tail = /^claude-[a-z]+-(.+)$/.exec(id)?.[1] ?? "";
  // A date suffix (20251101) is a release stamp, not a version component.
  return tail.split("-").filter((part) => /^\d+$/.test(part) && part.length < 5).map(Number);
}

function isNewer(candidate: string, incumbent: string): boolean {
  const left = versionOf(candidate);
  const right = versionOf(incumbent);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? -1;
    const b = right[i] ?? -1;
    if (a !== b) return a > b;
  }
  return false;
}

/** Title-case a display name when Anthropic did not send one. */
function nameFor(model: LiveModel): string {
  if (model.displayName) return model.displayName;
  const family = familyOf(model.id) ?? "";
  const version = versionOf(model.id).join(".");
  const pretty = family ? family[0].toUpperCase() + family.slice(1) : model.id;
  return version ? `Claude ${pretty} ${version}` : `Claude ${pretty}`;
}

const base = Object.values(PI_ANTHROPIC_MODELS as unknown as Record<string, AnthropicModel>);

/**
 * Newest model per family, used as the template for a model the live list
 * reports but pi has never seen. Inheriting beats guessing: a new Opus gets
 * the current Opus's context window, output cap, thinking levels and pricing,
 * and those track pi upgrades automatically.
 */
function templates(models: AnthropicModel[]): Map<string, AnthropicModel> {
  const newest = new Map<string, AnthropicModel>();
  for (const model of models) {
    const family = familyOf(model.id);
    if (!family) continue;
    const incumbent = newest.get(family);
    if (!incumbent || isNewer(model.id, incumbent.id)) newest.set(family, model);
  }
  return newest;
}

/** pi's catalogue, corrected, plus anything the live list knows about that pi does not. */
export function buildAnthropicModels(live: LiveModel[] = cachedAnthropicModels()): ModelSpec[] {
  const corrected = base.map((model) => ({ ...model, ...CORRECTIONS[model.id] })) as AnthropicModel[];
  const known = new Set(corrected.map((model) => model.id));
  const byFamily = templates(corrected);

  const discovered: AnthropicModel[] = [];
  for (const model of live) {
    if (known.has(model.id)) continue;
    const template = byFamily.get(familyOf(model.id) ?? "");
    if (!template) continue; // An unrecognised family has nothing safe to inherit.
    known.add(model.id);
    discovered.push({ ...template, id: model.id, name: nameFor(model) });
  }

  return [
    ...corrected,
    ...discovered,
    ...ADDITIONS.filter((model) => !known.has(model.id)),
  ] as unknown as ModelSpec[];
}

/** Snapshot taken at load; `refreshAnthropicModels()` re-registers on change. */
export const ANTHROPIC_MODELS: ModelSpec[] = buildAnthropicModels();
