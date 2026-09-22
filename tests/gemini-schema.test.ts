import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { bridgeSchema, selfContainedSchema } from "../src/core/gemini/schema.ts";

/**
 * Gemini takes JSON Schema only when self-contained, and its
 * Claude/GPT-OSS bridge takes only a protobuf subset: any other keyword is a
 * 400 for the whole request. MCP servers produce every shape below.
 */

test("local references are inlined and schema metadata removed", () => {
  const schema = selfContainedSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:tool",
    type: "object",
    properties: {
      target: { $ref: "#/$defs/Target", description: "where" },
      // A property *named* like a keyword is data, not a keyword.
      $id: { type: "string" },
    },
    $defs: { Target: { type: "object", properties: { path: { type: "string" } } } },
  });

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      target: { type: "object", properties: { path: { type: "string" } }, description: "where" },
      $id: { type: "string" },
    },
  });
});

test("circular, missing and remote references degrade to an unconstrained schema", () => {
  const schema = selfContainedSchema({
    type: "object",
    properties: {
      tree: { $ref: "#/$defs/Node" },
      missing: { $ref: "#/$defs/Nope" },
      remote: { $ref: "https://example.com/schema.json" },
    },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
  }) as any;

  assert.deepEqual(schema.properties.tree, { type: "object", properties: { child: {} } });
  assert.deepEqual(schema.properties.missing, {});
  assert.deepEqual(schema.properties.remote, {});
});

test("data keywords are copied verbatim, not walked as schemas", () => {
  const schema = selfContainedSchema({
    type: "object",
    properties: { mode: { type: "string", enum: ["a", "b"], default: "a", examples: [{ $ref: "not-a-schema" }] } },
  }) as any;
  assert.deepEqual(schema.properties.mode.examples, [{ $ref: "not-a-schema" }]);
});

test("a parameterless tool still declares an object", () => {
  assert.deepEqual(selfContainedSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(bridgeSchema({}), { type: "object", properties: {} });
});

test("the bridge keeps only the keywords it accepts", () => {
  const schema = bridgeSchema({
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", format: "uri", minLength: 1, description: "file" },
      limit: { type: ["integer", "null"], nullable: true },
      mode: { anyOf: [{ type: "null" }, { type: "string", enum: ["fast", "slow"] }], description: "speed" },
      level: { const: "debug" },
      mixed: { enum: ["a", 1] },
      tags: { type: "array", items: { type: "string", pattern: "^x" } },
    },
  });

  assert.deepEqual(schema, {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "file" },
      limit: { type: "integer" },
      mode: { type: "string", enum: ["fast", "slow"], description: "speed" },
      level: { enum: ["debug"] },
      mixed: {},
      tags: { type: "array", items: { type: "string" } },
    },
  });
});

test("TypeBox schemas, as pi's own tools declare them, bridge cleanly", () => {
  const schema = bridgeSchema(Type.Object({
    path: Type.String({ description: "file" }),
    offset: Type.Optional(Type.Number()),
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string", description: "file" }, offset: { type: "number" } },
  });
});
