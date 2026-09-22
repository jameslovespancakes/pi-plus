/**
 * Tool schemas in the two shapes the Antigravity backend accepts.
 *
 *   - Gemini reads full JSON Schema from `parametersJsonSchema`, but only
 *     self-contained: `$ref` must already be resolved and `$defs` removed.
 *   - Claude and GPT-OSS go through a custom-tool bridge that reads the
 *     legacy protobuf `parameters` field. It rejects every keyword it does not
 *     know (`nullable`, `anyOf`, `format`, `const`, …) with a 400, so the
 *     schema is reduced to an allowlist rather than a denylist: a new JSON
 *     Schema keyword can never break a request. pi still validates the
 *     arguments the model returns against the original schema.
 *
 * Tool schemas can come from MCP servers, so expansion is bounded. A
 * reference that cannot be resolved — missing, circular, or past a bound —
 * becomes the unconstrained schema `{}` instead of failing the whole request.
 */

type Json = Record<string, unknown>;

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

const METADATA = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"]);
/** Keywords whose value is a map of *names* to schemas; the names are never keywords. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas"]);
/** Keywords whose value is a schema, or an array of schemas. */
const SCHEMA_VALUES = new Set([
  "items", "prefixItems", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties",
  "contains", "propertyNames", "not", "if", "then", "else", "contentSchema", "allOf", "anyOf", "oneOf",
]);

const BRIDGE_KEYWORDS = new Set(["type", "description", "properties", "required", "items", "enum"]);

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** RFC 6901 pointer into the root schema; only local (`#…`) references resolve. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      node = node[Number(key)];
    } else if (isRecord(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return node;
}

/** A JSON Schema with every local `$ref` inlined and schema metadata removed. */
export function selfContainedSchema(schema: unknown): Json {
  let nodes = 0;

  const walk = (node: unknown, refs: ReadonlySet<string>, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return {};
    if (Array.isArray(node)) return node.map((item) => walk(item, refs, depth + 1));
    if (!isRecord(node)) return node;

    if (typeof node.$ref === "string") {
      const { $ref: ref, ...siblings } = node;
      const target = refs.has(ref) ? undefined : resolvePointer(schema, ref);
      const resolved = target === undefined ? {} : walk(target, new Set([...refs, ref]), depth + 1);
      const rest = walk(siblings, refs, depth + 1);
      return { ...(isRecord(resolved) ? resolved : {}), ...(isRecord(rest) ? rest : {}) };
    }

    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (METADATA.has(key)) continue;
      if (SCHEMA_MAPS.has(key) && isRecord(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, walk(sub, refs, depth + 1)]));
      } else if (SCHEMA_VALUES.has(key)) {
        out[key] = walk(value, refs, depth + 1);
      } else {
        // `enum`, `default`, `examples`… are data, not schemas: copied verbatim.
        out[key] = value;
      }
    }
    return out;
  };

  return asObjectRoot(walk(schema, new Set(), 0));
}

/** Function declarations must describe an object, even for a tool with no parameters. */
function asObjectRoot(schema: unknown): Json {
  if (!isRecord(schema)) return { type: "object", properties: {} };
  return schema.type ? schema : { ...schema, type: "object", properties: schema.properties ?? {} };
}

/** `["string", "null"]` → `"string"`: the bridge takes a single type. */
function singleType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.find((entry): entry is string => typeof entry === "string" && entry !== "null") : undefined;
}

/**
 * A union the bridge cannot express is narrowed to its first non-null branch,
 * which keeps the common `T | null` shape typed instead of unconstrained.
 */
function firstBranch(node: Json): Json | undefined {
  const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  return branches?.find((branch): branch is Json => isRecord(branch) && branch.type !== "null");
}

function toBridge(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const branch = node.type === undefined ? firstBranch(node) : undefined;
  const source = branch ? { ...branch, ...(node.description !== undefined && { description: node.description }) } : node;

  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (!BRIDGE_KEYWORDS.has(key)) continue;
    if (key === "type") {
      const type = singleType(value);
      if (type) out.type = type;
    } else if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, toBridge(sub)]));
    } else if (key === "enum") {
      // The bridge's enum is string-only; a mixed enum is dropped rather than coerced.
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) out.enum = value;
    } else if (key === "items") {
      out.items = toBridge(Array.isArray(value) ? value[0] : value);
    } else {
      out[key] = value;
    }
  }
  if (typeof source.const === "string" && out.enum === undefined) out.enum = [source.const];
  return out;
}

/** The subset of a tool schema Gemini's Claude/GPT-OSS bridge accepts. */
export function bridgeSchema(schema: unknown): Json {
  return asObjectRoot(toBridge(selfContainedSchema(schema)));
}
