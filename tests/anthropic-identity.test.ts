import test from "node:test";
import assert from "node:assert/strict";
import { anthropicAccountIdentity } from "../src/core/anthropic/identity.ts";

test("Claude account identity comes from the bootstrap account UUID", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
    return new Response(JSON.stringify({ oauth_account: { account_uuid: "account-1" } }), { status: 200 });
  };

  const identity = await anthropicAccountIdentity("sk-ant-oat01-test-token", fetchImpl);

  assert.equal(identity, "account-1");
  assert.match(requests[0]!.url, /\/api\/claude_cli\/bootstrap\?entrypoint=cli$/);
  assert.equal(requests[0]!.authorization, "Bearer sk-ant-oat01-test-token");
});

test("Claude identity lookup fails closed for unavailable metadata", async () => {
  const missing = await anthropicAccountIdentity(
    "sk-ant-oat01-missing-token",
    async () => new Response("{}", { status: 200 }),
  );
  const opaque = await anthropicAccountIdentity("opaque-token", async () => {
    throw new Error("must not fetch");
  });

  assert.equal(missing, undefined);
  assert.equal(opaque, undefined);
});
