import test from "node:test";
import assert from "node:assert/strict";
import { canonicalBodyBytes, signRequestBody } from "../src/providers/anthropic/client-identity.ts";

/**
 * Claude Code 2.1.290+ computes `cch` natively over the raw body bytes. Every
 * `"model":"…"` value is blanked, including ones inside tool definitions, and
 * `max_tokens`, `fallbacks` and `fallback_credit_token` are dropped. The old
 * JSON-based canonicalisation only blanked the top-level model, so bodies
 * with an advisor tool were signed wrongly.
 *
 * The expected token was checked against an independent reimplementation that
 * reproduces real 2.1.290 and 2.1.325 requests.
 */

const header = "x-anthropic-billing-header: cc_version=2.1.290.abc; cc_entrypoint=cli; cch=00000;";
const body = {
  model: "claude-opus-5-5",
  system: [{ type: "text", text: header }],
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "advisor", model: "claude-fable-5-1" }],
  max_tokens: 64000,
  fallback_credit_token: "tok",
  stream: true,
  fallbacks: [[1], "x]"],
};

const cch = (signed: string) => signed.match(/cch=([0-9a-f]{5});/)?.[1];

test("canonical body blanks every model and drops excluded members", () => {
  const out = new TextDecoder().decode(canonicalBodyBytes(new TextEncoder().encode(JSON.stringify(body))));
  assert.equal(out, JSON.stringify({
    model: "",
    system: [{ type: "text", text: header }],
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "advisor", model: "" }],
    stream: true,
  }));
});

test("cch matches Claude Code's native signer", async () => {
  assert.equal(cch(await signRequestBody(JSON.stringify(body))), "5a27a");
});

test("cch ignores model and token limits but covers content", async () => {
  const base = cch(await signRequestBody(JSON.stringify(body)));
  const other = { ...body, model: "x", max_tokens: 1, tools: [{ name: "advisor", model: "y" }] };
  assert.equal(cch(await signRequestBody(JSON.stringify(other))), base);
  const changed = { ...body, messages: [{ role: "user", content: "hello" }] };
  assert.notEqual(cch(await signRequestBody(JSON.stringify(changed))), base);
});

test("re-signing an already signed body is stable", async () => {
  const once = await signRequestBody(JSON.stringify(body));
  assert.equal(await signRequestBody(once), once);
});
