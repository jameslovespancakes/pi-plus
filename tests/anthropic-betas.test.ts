import test from "node:test";
import assert from "node:assert/strict";
import { clientIdentityHeaders, identityBetas } from "../src/core/anthropic/client-identity.ts";

/**
 * pi enables model-specific betas that authorise fields pi itself emits.
 * `mid-conversation-output-config-2026-07-01` covers the `output_config`
 * system messages inserted for adaptive-effort models such as Opus 5.
 *
 * Substituting the beta list leaves those messages in the body with nothing
 * permitting them, and every request to such a model fails with
 * `messages.1.output_config: Extra inputs are not permitted`.
 */

const PI_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "mid-conversation-output-config-2026-07-01",
  "thinking-binding-controls-2026-08-01",
  "mid-conversation-tool-changes-2026-07-01",
];

test("the identity never sets anthropic-beta, which pi copies into the body", () => {
  const headers = clientIdentityHeaders();
  assert.equal(headers["anthropic-beta"], undefined);
  // The rest of the Claude Code identity is still present.
  assert.match(headers["user-agent"], /^claude-cli\//);
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("pi's betas all survive the merge", () => {
  const merged = identityBetas({}, PI_BETAS);
  for (const beta of PI_BETAS) {
    assert.ok(merged.includes(beta), `${beta} was dropped`);
  }
});

test("the identity's own betas are added, without duplicates", () => {
  const merged = identityBetas({}, PI_BETAS);
  assert.ok(merged.includes("oauth-2025-04-20"));
  assert.ok(merged.length > PI_BETAS.length, "identity betas should be added");
  assert.equal(new Set(merged).size, merged.length, "duplicate betas");
});

test("merging works from an empty list and ignores blanks", () => {
  const fromNothing = identityBetas({});
  assert.ok(fromNothing.includes("oauth-2025-04-20"));
  assert.deepEqual(identityBetas({}, ["", "  "]), fromNothing);
});

test("a full agent turn keeps the mid-conversation betas pi supplied", () => {
  // Tools + system blocks + thinking is the shape that selects the wider set.
  const body = {
    tools: [{ name: "read" }],
    system: [{ type: "text", text: "x" }],
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [],
  };
  const merged = identityBetas(body, PI_BETAS);
  assert.ok(merged.includes("mid-conversation-output-config-2026-07-01"));
  assert.ok(merged.includes("claude-code-20250219"));
});
