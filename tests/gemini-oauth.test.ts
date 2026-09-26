import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverProjectId,
  extractProjectId,
  fallbackProjectId,
  stableUuid,
} from "../src/core/gemini/client.ts";
import {
  credentialEmail,
  credentialProjectId,
  decodeApiKey,
  encodeApiKey,
} from "../src/core/gemini/credentials.ts";
import { geminiOAuth, requestProjectId } from "../src/core/gemini/oauth.ts";
import { oauthSuccessHtml } from "../src/core/oauth/callback-server.ts";

interface Call { url: string; body: any }

/** Stubs `fetch` by URL substring; unmatched requests answer 404. */
async function withGoogle(routes: Record<string, () => Response>, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : typeof raw === "string" ? JSON.parse(raw) : undefined;
    calls.push({ url, body });
    const route = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    return route ? route[1]() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function withEnv(name: string, value: string | undefined, run: () => Promise<void> | void) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("the project id survives the round trip through apiKey", () => {
  const encoded = encodeApiKey({ token: "ya29.token", projectId: "my-project" });
  assert.deepEqual(decodeApiKey(encoded), { token: "ya29.token", projectId: "my-project" });
  for (const input of [undefined, "", "ya29.raw-token", "{}", JSON.stringify({ token: "t" })]) {
    assert.throws(() => decodeApiKey(input), /\/login gemini/, `accepted ${String(input)}`);
  }
});

test("credential accessors ignore missing and empty fields", () => {
  const base = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
  assert.equal(credentialProjectId(base), undefined);
  assert.equal(credentialProjectId({ ...base, projectId: "" }), undefined);
  assert.equal(credentialProjectId({ ...base, projectId: "p" }), "p");
  assert.equal(credentialEmail({ ...base, email: "a@b.c" }), "a@b.c");
});

test("the project is found in every response shape the backend has used", () => {
  assert.equal(extractProjectId({ cloudaicompanionProject: "p1" }), "p1");
  assert.equal(extractProjectId({ cloudaicompanionProject: { id: "p2" } }), "p2");
  assert.equal(extractProjectId({ geminiProjectId: "p3", project: "ignored" }), "p3");
  assert.equal(extractProjectId({ projects: [{ projectId: "p4" }] }), "p4");
  assert.equal(extractProjectId({ projectIds: ["p5"] }), "p5");
  assert.equal(extractProjectId({ currentTier: { id: "free-tier" } }), undefined);
});

test("discovery reads loadCodeAssist, falling through a failing endpoint", async () => {
  let first = true;
  await withGoogle({
    "loadCodeAssist": () => {
      if (first) { first = false; return new Response("down", { status: 503 }); }
      return Response.json({ cloudaicompanionProject: "managed-1" });
    },
  }, async (calls) => {
    assert.equal(await discoverProjectId("ya29.t"), "managed-1");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { metadata: { ideType: "ANTIGRAVITY" } });
  });
});

test("an account without a project is asked for its project list", async () => {
  await withGoogle({
    "loadCodeAssist": () => Response.json({ currentTier: { id: "free-tier" } }),
    "listCloudAICompanionProjects": () => Response.json({ projects: [{ projectId: "listed-1" }] }),
  }, async () => {
    assert.equal(await discoverProjectId("ya29.t"), "listed-1");
  });
});

test("an account Google allocated nothing to gets a stable per-account project", async () => {
  await withGoogle({ "loadCodeAssist": () => Response.json({}), "listCloudAICompanionProjects": () => Response.json({}) }, async () => {
    assert.equal(await discoverProjectId("ya29.t"), undefined);
  });
  assert.match(stableUuid("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fallbackProjectId("a@b.c"), fallbackProjectId("a@b.c"));
  assert.notEqual(fallbackProjectId("a@b.c"), fallbackProjectId("d@e.f"));
});

test("PI_GEMINI_PROJECT_ID pins the project everywhere, without a network call", async () => {
  await withEnv("PI_GEMINI_PROJECT_ID", "pinned-1", async () => {
    await withGoogle({}, async (calls) => {
      assert.equal(await discoverProjectId("ya29.t"), "pinned-1");
      assert.equal(calls.length, 0);
    });
    assert.equal(requestProjectId({ type: "oauth", access: "a", refresh: "r", expires: 0, projectId: "stored" } as any), "pinned-1");
  });
});

test("request auth carries the stored project, else a stable fallback", async () => {
  const base = { type: "oauth" as const, access: "ya29.a", refresh: "r", expires: 0 };
  await withEnv("PI_GEMINI_PROJECT_ID", undefined, async () => {
    const stored = decodeApiKey((await geminiOAuth.toAuth({ ...base, projectId: "stored" } as any)).apiKey);
    assert.deepEqual(stored, { token: "ya29.a", projectId: "stored" });
    const fallback = decodeApiKey((await geminiOAuth.toAuth({ ...base, email: "a@b.c" } as any)).apiKey);
    assert.equal(fallback.projectId, fallbackProjectId("a@b.c"));
  });
});

test("a refresh keeps the login-time project, email and unrotated refresh token", async () => {
  await withGoogle({ "oauth2.googleapis.com/token": () => Response.json({ access_token: "ya29.new", expires_in: 3600 }) }, async (calls) => {
    const refreshed = await geminiOAuth.refresh(
      { type: "oauth", access: "ya29.old", refresh: "1//refresh", expires: 0, projectId: "p", email: "a@b.c" } as any,
      new AbortController().signal,
    ) as any;
    assert.equal(refreshed.access, "ya29.new");
    assert.equal(refreshed.refresh, "1//refresh");
    assert.equal(refreshed.projectId, "p");
    assert.equal(refreshed.email, "a@b.c");
    assert.ok(refreshed.expires > Date.now());
    assert.equal(calls.length, 1, "nothing to rediscover");
    assert.equal(calls[0].body.grant_type, "refresh_token");
  });
});

test("a refresh retries project discovery that failed at login", async () => {
  await withGoogle({
    "oauth2.googleapis.com/token": () => Response.json({ access_token: "ya29.new", expires_in: 3600 }),
    "loadCodeAssist": () => Response.json({ cloudaicompanionProject: "found-later" }),
  }, async () => {
    const refreshed = await geminiOAuth.refresh(
      { type: "oauth", access: "a", refresh: "r", expires: 0, email: "a@b.c" } as any,
      new AbortController().signal,
    ) as any;
    assert.equal(refreshed.projectId, "found-later");
  });
});

test("a rejected refresh names Google's reason", async () => {
  await withGoogle({
    "oauth2.googleapis.com/token": () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }),
  }, async () => {
    await assert.rejects(
      () => geminiOAuth.refresh({ type: "oauth", access: "a", refresh: "r", expires: 0 } as any, new AbortController().signal),
      /invalid_grant: Token has been expired or revoked/,
    );
  });
});

test("the browser callback acknowledges authorization without claiming completed sign-in", () => {
  const html = oauthSuccessHtml("Return to pi to confirm account access.");
  assert.match(html, /<title>Authorization received<\/title>/);
  assert.doesNotMatch(html, /Signed in|sign-in complete/i);
});

test("login binds the callback to its own state and exchanges with PKCE", async () => {
  let authUrl: URL | undefined;
  await withEnv("PI_GEMINI_PROJECT_ID", undefined, () => withGoogle({
    "oauth2.googleapis.com/token": () => Response.json({ access_token: "ya29.first", refresh_token: "1//r", expires_in: 3600 }),
    "userinfo": () => Response.json({ email: "me@example.com" }),
    "loadCodeAssist": () => Response.json({ cloudaicompanionProject: "managed-1" }),
    "retrieveUserQuota": () => Response.json({ buckets: [] }),
  }, async (calls) => {
    const credential = await geminiOAuth.login({
      signal: new AbortController().signal,
      notify: (event) => { if (event.type === "auth_url") authUrl = new URL(event.url); },
      // A headless session pastes the callback URL instead of the browser hitting loopback.
      prompt: async () => `http://localhost:51121/oauth-callback?code=the-code&state=${authUrl!.searchParams.get("state")}`,
    }) as any;

    assert.equal(credential.access, "ya29.first");
    assert.equal(credential.projectId, "managed-1");
    assert.equal(credential.email, "me@example.com");
    assert.equal(calls.filter((call) => call.url.includes("retrieveUserQuota")).length, 1, "login must confirm account access before returning credentials");

    assert.equal(authUrl!.searchParams.get("redirect_uri"), "http://localhost:51121/oauth-callback");
    assert.equal(authUrl!.searchParams.get("access_type"), "offline");
    assert.match(authUrl!.searchParams.get("scope")!, /auth\/aicode/);

    const exchange = calls.find((call) => call.url.includes("oauth2.googleapis.com/token"))!;
    assert.equal(exchange.body.code, "the-code");
    assert.ok(exchange.body.code_verifier);
    // A leaked callback URL must not also disclose the PKCE verifier.
    assert.notEqual(exchange.body.code_verifier, authUrl!.searchParams.get("state"));
  }));
});

test("a pasted callback from another sign-in is refused", async () => {
  await assert.rejects(() => geminiOAuth.login({
    signal: new AbortController().signal,
    notify: () => {},
    prompt: async () => "http://localhost:51121/oauth-callback?code=c&state=someone-else",
  }), /state mismatch/);
});
