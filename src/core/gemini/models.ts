import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GEMINI_ENDPOINT, type RuntimeModelInfo } from "./client.ts";

/**
 * Gemini's model catalogue.
 *
 * The backend serves each model as several *runtime* ids — one per thinking
 * level, e.g. `gemini-3.8-flash-low` / `-medium` / `-high` — and pi exposes
 * one public model with those levels. The runtime id for each level is stored
 * as that level's `thinkingLevelMap` value, which is exactly what pi defines
 * the value to be: "sent to the provider". So routing lives on the `Model`
 * itself, survives pi's model-store persistence, and needs no side table.
 *
 * Facts pi already knows (name, context window, input types) come from pi's
 * own Google catalogue where it has the model. What is Gemini's alone —
 * which runtime id serves which level, and each family's output ceiling — is
 * defined here.
 */

export const GEMINI_API = "gemini";
export const GEMINI_PROVIDER = "gemini";

export type GeminiModel = Model<typeof GEMINI_API>;

type Level = Exclude<ModelThinkingLevel, "off" | "max">;
type Variants = Partial<Record<Level, string>>;

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The subscription has already paid; nothing here is metered. */
const FREE: GeminiModel["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface Family {
  test: RegExp;
  contextWindow: number;
  /** Largest `maxOutputTokens` the backend accepts; above it answers 400. */
  maxTokens: number;
  input: GeminiModel["input"];
}

/** Ordered: the first match wins, so the specific Gemini Pro entry precedes Gemini. */
const FAMILIES: readonly Family[] = [
  { test: /^claude-/, contextWindow: 200_000, maxTokens: 64_000, input: ["text", "image"] },
  { test: /^gpt-oss-/, contextWindow: 131_072, maxTokens: 32_768, input: ["text"] },
  { test: /^gemini-(?:.*-)?pro\b/, contextWindow: 1_048_576, maxTokens: 65_535, input: ["text", "image"] },
  { test: /^gemini-/, contextWindow: 1_048_576, maxTokens: 65_536, input: ["text", "image"] },
];
const UNKNOWN_FAMILY: Family = { test: /$^/, contextWindow: 128_000, maxTokens: 8_192, input: ["text"] };

const familyOf = (id: string): Family => FAMILIES.find((family) => family.test.test(id)) ?? UNKNOWN_FAMILY;

/** pi's own definition of the same model, when its Google catalogue carries it. */
function piModel(id: string): Model<Api> | undefined {
  return (GOOGLE_MODELS as Record<string, Model<Api>>)[id];
}

interface Definition {
  id: string;
  name: string;
  /** Runtime id per advertised thinking level; empty for a model without thinking. */
  variants: Variants;
  /** Runtime id when the model has no thinking variants and differs from its public id. */
  runtime?: string;
  input?: GeminiModel["input"];
}

function defineModel({ id, name, variants, runtime, input }: Definition): GeminiModel {
  const family = familyOf(id);
  const known = piModel(id);
  const reasoning = Object.keys(variants).length > 0;
  const thinkingLevelMap: ThinkingLevelMap | undefined = reasoning
    ? Object.fromEntries(LEVELS.map((level) => [level, variants[level as Level] ?? null]))
    : runtime && runtime !== id ? { off: runtime } : undefined;

  return {
    id,
    name,
    api: GEMINI_API,
    provider: GEMINI_PROVIDER,
    baseUrl: GEMINI_ENDPOINT,
    reasoning,
    ...(thinkingLevelMap && { thinkingLevelMap }),
    input: input ?? known?.input ?? family.input,
    cost: FREE,
    contextWindow: known?.contextWindow ?? family.contextWindow,
    maxTokens: Math.min(known?.maxTokens ?? family.maxTokens, family.maxTokens),
  };
}

const tiered = (base: string): Variants => ({ low: `${base}-low`, medium: `${base}-medium`, high: `${base}-high` });

/**
 * The conservative baseline, selectable before the first live refresh and for
 * accounts whose catalogue omits an entry. Mirrors `agy models`.
 */
export const STATIC_MODELS: readonly GeminiModel[] = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", variants: tiered("gemini-3.8-flash") },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", variants: tiered("gemini-3.7-flash") },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", variants: tiered("gemini-3.6-flash") },
  {
    // The backend labels these one step off their ids: `-extra-low` is shown
    // as Low, `-low` as Medium, and High is a separate agent runtime.
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    variants: { low: "gemini-3.5-flash-extra-low", medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent" },
  },
  {
    // `gemini-3.1-pro-high` is advertised but rejects agent requests;
    // `gemini-pro-agent` serves High under the same display name.
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    variants: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" },
  },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", variants: { high: "claude-opus-4-6-thinking" } },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", variants: { high: "claude-sonnet-4-6" } },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", variants: { medium: "gpt-oss-120b-medium" } },
].map(defineModel);

/**
 * The runtime id serving `level`. With thinking off, or a level the model
 * does not advertise, the lightest variant serves it with thinking disabled.
 */
export function runtimeModelId(model: Model<Api>, level?: ModelThinkingLevel): string {
  const map = model.thinkingLevelMap;
  const requested = map?.[level ?? "off"];
  if (typeof requested === "string") return requested;
  for (const candidate of LEVELS) {
    const value = map?.[candidate];
    if (typeof value === "string") return value;
  }
  return model.id;
}

export interface ThinkingConfig {
  includeThoughts: boolean;
  thinkingBudget: number;
}

type Budgets = Record<"low" | "medium" | "high", number>;

/**
 * Integer budgets per runtime family, matching the Antigravity CLI's wire
 * format. `-1` lets Gemini decide. Ordered like {@link FAMILIES}.
 */
const BUDGETS: ReadonlyArray<readonly [RegExp, Budgets]> = [
  [/^claude-/, { low: 1024, medium: 1024, high: 1024 }],
  [/^gpt-oss-/, { low: 8192, medium: 8192, high: 8192 }],
  [/^gemini-3\.5-flash|^gemini-3-flash-agent$/, { low: 1000, medium: 4000, high: 10_000 }],
  [/^gemini-3\.1-pro|^gemini-pro-agent$/, { low: 1001, medium: 1001, high: 10_001 }],
  [/^gemini-/, { low: 1000, medium: 4000, high: -1 }],
];

/** Undefined for a runtime family the budgets are not known for: send none. */
export function thinkingConfig(runtimeId: string, level?: ModelThinkingLevel): ThinkingConfig | undefined {
  const budgets = BUDGETS.find(([test]) => test.test(runtimeId))?.[1];
  if (!budgets) return undefined;
  if (!level || level === "off") return { includeThoughts: false, thinkingBudget: 0 };
  const tier = level === "medium" ? "medium" : level === "minimal" || level === "low" ? "low" : "high";
  return { includeThoughts: true, thinkingBudget: budgets[tier] };
}

// --- Live catalogue ---------------------------------------------------------

/** Chat/tab autocomplete, image, and enum-placeholder entries are not agent models. */
export function isSelectableRuntimeId(id: string): boolean {
  return /^(gemini-|claude-|gpt-oss-)/i.test(id)
    && !/\s/.test(id)
    && !/^(MODEL_|chat_|tab_)/i.test(id)
    && !/image/i.test(id);
}

const SUFFIXES: ReadonlyArray<readonly [string, Level]> = [
  ["extra-low", "low"],
  ["extra-high", "xhigh"],
  ["thinking", "high"],
  ["minimal", "minimal"],
  ["medium", "medium"],
  ["high", "high"],
  ["low", "low"],
];

const DISPLAY_LEVELS: ReadonlyArray<readonly [RegExp, Level]> = [
  [/\(\s*extra\s*low\s*\)/i, "low"],
  [/\(\s*extra\s*high\s*\)/i, "xhigh"],
  [/\(\s*thinking\s*\)/i, "high"],
  [/\(\s*minimal\s*\)/i, "minimal"],
  [/\(\s*medium\s*\)/i, "medium"],
  [/\(\s*high\s*\)/i, "high"],
  [/\(\s*low\s*\)/i, "low"],
];

/** Runtime ids that share no suffix with the family they serve. */
const ALIASES: Record<string, readonly [string, Level]> = {
  "gemini-3-flash-agent": ["gemini-3.5-flash", "high"],
  "gemini-pro-agent": ["gemini-3.1-pro", "high"],
};

interface Group {
  id: string;
  variants: Variants;
  unsuffixed?: string;
  names: string[];
  thinks?: boolean;
  images?: boolean;
}

function displayName(info: RuntimeModelInfo | undefined): string | undefined {
  const name = info?.displayName || info?.label || info?.modelName;
  return typeof name === "string" && name ? name : undefined;
}

/** The display name wins over the id: the backend's ids are sometimes a level off. */
function levelFromName(name: string | undefined): Level | undefined {
  return name ? DISPLAY_LEVELS.find(([pattern]) => pattern.test(name))?.[1] : undefined;
}

function splitSuffix(runtimeId: string): { base: string; level: Level } | undefined {
  const lower = runtimeId.toLowerCase();
  const match = SUFFIXES.find(([suffix]) => lower.endsWith(`-${suffix}`));
  return match ? { base: runtimeId.slice(0, -(match[0].length + 1)), level: match[1] } : undefined;
}

/** "Gemini 3.9 Flash (Low)" → "gemini 3.9 flash". */
function displayFamily(name: string | undefined): string | undefined {
  return name
    ?.replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
    .trim()
    .toLowerCase() || undefined;
}

function groupFor(groups: Map<string, Group>, id: string): Group {
  let group = groups.get(id);
  if (!group) groups.set(id, group = { id, variants: {}, names: [] });
  return group;
}

function absorb(group: Group, info: RuntimeModelInfo | undefined, name: string | undefined): void {
  if (name) group.names.push(name);
  // "True anywhere" wins: one variant advertising a capability is enough.
  if (info?.supportsThinking === true) group.thinks = true;
  else if (info?.supportsThinking === false) group.thinks ??= false;
  if (info?.supportsImages === true) group.images = true;
  else if (info?.supportsImages === false) group.images ??= false;
}

/**
 * A lone `*-agent` runtime id is a level of the family sharing its display
 * name — High unless the name says otherwise — not a model of its own (e.g. a
 * new `gemini-4-flash-agent` shown as "Gemini 4 Flash (High)"). The agent id
 * wins the level: the backend advertises plain `-high` ids that reject agent
 * requests while the agent id serves them.
 */
function mergeAgentSingletons(groups: Map<string, Group>): void {
  // Deleting the entry being visited is well-defined for a Map iterator.
  for (const [id, group] of groups) {
    const own = [group.unsuffixed, ...Object.values(group.variants)].filter((value) => value !== undefined);
    if (!id.endsWith("-agent") || own.length !== 1) continue;
    const family = displayFamily(group.names[0]);
    if (!family) continue;
    const target = [...groups.values()].find((candidate) =>
      candidate.id !== id && candidate.names.some((name) => displayFamily(name) === family));
    if (!target) continue;
    target.variants[levelFromName(group.names[0]) ?? "high"] = own[0];
    absorb(target, { supportsThinking: group.thinks }, group.names[0]);
    groups.delete(id);
  }
}

/** "gpt-oss-120b" → "GPT-OSS 120B", "gemini-4-0-flash" → "Gemini 4.0 Flash". */
export function humanizeModelId(id: string): string {
  const tokens = id.split("-");
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (!token) continue;
    if (token === "gpt" && next === "oss") { words.push("GPT-OSS"); index++; continue; }
    if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) { words.push(`${token}.${next}`); index++; continue; }
    words.push(/^\d/.test(token) ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}

function synthesize(group: Group): GeminiModel {
  let variants = group.variants;
  // No per-level ids: a thinking model is served at one level by its plain id.
  if (Object.keys(variants).length === 0 && group.thinks !== false) {
    variants = { high: group.unsuffixed ?? group.id };
  }
  const family = group.names.map(displayFamily).find(Boolean);
  return defineModel({
    id: group.id,
    name: family ? family.replace(/\b([a-z])/g, (char) => char.toUpperCase()) : humanizeModelId(group.id),
    variants,
    runtime: group.unsuffixed,
    ...(group.images !== undefined && { input: group.images ? ["text", "image"] : ["text"] }),
  });
}

function rank(id: string): readonly [number, number] {
  const version = /^gemini-(\d+)(?:\.(\d+))?/i.exec(id);
  const order = version ? -(Number(version[1]) * 1000 + Number(version[2] ?? 0)) : 0;
  if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return [0, order];
  if (id.startsWith("claude-opus")) return [1, 0];
  if (id.startsWith("claude-sonnet")) return [2, 0];
  if (id.startsWith("claude-")) return [3, 0];
  if (/^gemini-.*pro/i.test(id)) return [4, order];
  if (id.startsWith("gemini-")) return [5, order];
  if (id.startsWith("gpt-oss")) return [6, 0];
  return [7, 0];
}

function compareModels(left: Model<Api>, right: Model<Api>): number {
  const [a, b] = [rank(left.id), rank(right.id)];
  return a[0] - b[0] || a[1] - b[1] || left.id.localeCompare(right.id);
}

/**
 * The static baseline plus whatever else `extra` carries, sorted. Static
 * entries always win by id: their routing is verified, and a persisted
 * catalogue from an older pi-plus must not override a corrected one.
 */
export function withStaticModels(extra: readonly Model<Api>[]): GeminiModel[] {
  const byId = new Map<string, GeminiModel>(STATIC_MODELS.map((model) => [model.id, model]));
  for (const model of extra) {
    if (model.provider === GEMINI_PROVIDER && !byId.has(model.id)) byId.set(model.id, model as GeminiModel);
  }
  return [...byId.values()].sort(compareModels);
}

/**
 * Groups `fetchAvailableModels` runtime ids into public pi models: newly
 * enabled models become selectable without a pi-plus release.
 */
export function buildCatalog(runtimeModels: Record<string, RuntimeModelInfo>): GeminiModel[] {
  const groups = new Map<string, Group>();

  for (const [runtimeId, info] of Object.entries(runtimeModels)) {
    if (!isSelectableRuntimeId(runtimeId) || info?.isInternal) continue;
    const name = displayName(info);

    if (runtimeId.endsWith("-tiered")) {
      const group = groupFor(groups, runtimeId.slice(0, -"-tiered".length));
      absorb(group, info, name);
      group.unsuffixed ??= runtimeId;
      continue;
    }

    const alias = ALIASES[runtimeId];
    const suffix = alias ? undefined : splitSuffix(runtimeId);
    const group = groupFor(groups, alias?.[0] ?? suffix?.base ?? runtimeId);
    absorb(group, info, name);

    const level = alias?.[1] ?? levelFromName(name) ?? suffix?.level;
    if (level) group.variants[level] = runtimeId;
    else group.unsuffixed = runtimeId;
  }

  mergeAgentSingletons(groups);
  return withStaticModels([...groups.values()].map(synthesize));
}
