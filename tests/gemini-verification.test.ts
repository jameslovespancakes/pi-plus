import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { GeminiVerificationRequiredError, fetchUserQuota } from "../src/core/gemini/client.ts";
import { confirmGeminiAccess } from "../src/core/gemini/oauth.ts";

const verificationUrl = "https://accounts.google.com/signin/continue?flowName=test&private=challenge";
const credential = () => ({
  type: "oauth" as const, access: "ya29.test", refresh: "refresh", expires: Date.now() + 3_600_000,
  projectId: "project", email: "test@example.com",
});
const allowed = () => Response.json({ buckets: [{ modelId: "gemini-pro-agent", remainingFraction: 1 }] });
function denied(url: string = verificationUrl) {
  return Response.json({ error: {
    // Structured reasons work independently of Google's localized message.
    message: "Verification needed",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      domain: "cloudcode-pa.googleapis.com", reason: "VALIDATION_REQUIRED",
      metadata: { validation_url: url },
    }],
  } }, { status: 403 });
}

async function withFetch(handler: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = original; }
}

function interaction(prompt: ProviderAuthInteraction["prompt"] = async () => {
  throw new Error("Unexpected prompt");
}) {
  const events: Parameters<ProviderAuthInteraction["notify"]>[0][] = [];
  const controller = new AbortController();
  const ui: ProviderAuthInteraction = { signal: controller.signal, prompt, notify: (event) => events.push(event) };
  return { ui, events, controller };
}

test("successful login confirmation uses only the quota endpoint, with no browser or prompts", async () => {
  const auth = credential();
  const { ui, events } = interaction();
  let calls = 0;
  await withFetch(async (url, init) => {
    calls++;
    assert.match(String(url), /v1internal:retrieveUserQuota$/);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer ya29.test");
    assert.deepEqual(JSON.parse(String(init?.body)), { project: "project" });
    assert.ok(init?.signal);
    return allowed();
  }, async () => {
    assert.equal(await confirmGeminiAccess(auth, ui), auth);
    assert.equal(calls, 1);
    assert.equal(events.filter((event) => event.type === "auth_url").length, 0);
  });
});

test("verification opens through pi's auth UI and only a successful recheck completes login", async () => {
  let verified = false;
  let calls = 0;
  const { ui, events } = interaction(async (prompt) => {
    assert.equal(prompt.type, "select");
    assert.equal(calls, 3, "all endpoints denied access before asking the user");
    assert.deepEqual(events.filter((event) => event.type === "auth_url").map((event) => event.url), [verificationUrl]);
    verified = true;
    return "check";
  });
  await withFetch(async () => { calls++; return verified ? allowed() : denied(); }, async () => {
    await confirmGeminiAccess(credential(), ui);
    assert.equal(calls, 4, "user confirmation alone must not complete login");
  });
});

test("an uncleared challenge never succeeds and retries are user-driven and bounded", async () => {
  let checks = 0;
  let calls = 0;
  const { ui, events } = interaction(async () => { checks++; return "check"; });
  await withFetch(async () => { calls++; return denied(); }, async () => {
    await assert.rejects(confirmGeminiAccess(credential(), ui), /sign-in was not completed/);
    assert.equal(checks, 3);
    assert.equal(calls, 12);
    assert.equal(events.filter((event) => event.type === "auth_url").length, 1, "the same page is not reopened on every check");
  });
});

test("cancelling verification does not return credentials", async () => {
  const { ui } = interaction(async () => "cancel");
  await withFetch(async () => denied(), async () => {
    await assert.rejects(confirmGeminiAccess(credential(), ui), /sign-in cancelled/);
  });
});

test("abort during verification stops before any further quota request", async () => {
  let calls = 0;
  const { ui, controller } = interaction(async () => { controller.abort(); return "check"; });
  await withFetch(async () => { calls++; return denied(); }, async () => {
    await assert.rejects(confirmGeminiAccess(credential(), ui), { name: "AbortError" });
    assert.equal(calls, 3);
  });
});

test("a failed access check cannot be reported as a successful login", async () => {
  const { ui, events } = interaction();
  await withFetch(async () => new Response("unavailable", { status: 503 }), async () => {
    await assert.rejects(confirmGeminiAccess(credential(), ui), /HTTP 503/);
    assert.equal(events.filter((event) => event.type === "auth_url").length, 0);
  });
});

test("credentials expiring while the user verifies are refreshed before the recheck", async () => {
  const auth = credential();
  let verified = false;
  let refreshes = 0;
  const { ui } = interaction(async () => { verified = true; auth.expires = 0; return "check"; });
  await withFetch(async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      refreshes++;
      return Response.json({ access_token: "ya29.new", expires_in: 3600 });
    }
    assert.match(String(url), /retrieveUserQuota$/);
    assert.equal(new Headers(init?.headers).get("Authorization"), verified ? "Bearer ya29.new" : "Bearer ya29.test");
    return verified ? allowed() : denied();
  }, async () => {
    const refreshed = await confirmGeminiAccess(auth, ui);
    assert.equal(refreshed.access, "ya29.new");
    assert.equal(refreshed.refresh, "refresh");
    assert.equal(refreshes, 1);
  });
});

test("project discovery blocked at login is retried after browser verification", async () => {
  const { projectId: _project, ...auth } = credential();
  let verified = false;
  const { ui } = interaction(async () => { verified = true; return "check"; });
  await withFetch(async (url, init) => {
    if (String(url).endsWith(":loadCodeAssist")) {
      assert.equal(verified, true);
      return Response.json({ cloudaicompanionProject: "new-project" });
    }
    assert.match(String(url), /retrieveUserQuota$/);
    if (verified) assert.deepEqual(JSON.parse(String(init?.body)), { project: "new-project" });
    return verified ? allowed() : denied();
  }, async () => {
    const confirmed = await confirmGeminiAccess(auth, ui);
    assert.equal(confirmed.projectId, "new-project");
  });
});

test("verification URLs accept only the known HTTPS Google destination and are not serialized", async () => {
  for (const url of [
    "https://evil.example/signin/continue",
    "https://accounts.google.com.evil.example/signin/continue",
    "http://accounts.google.com/signin/continue",
    "https://user:password@accounts.google.com/signin/continue",
    "https://accounts.google.com:8443/signin/continue",
    "https://accounts.google.com/unknown",
    "javascript:alert(1)",
  ]) {
    assert.equal(new GeminiVerificationRequiredError(url).verificationUrl, undefined);
  }
  await withFetch(async () => denied(), async () => {
    await assert.rejects(fetchUserQuota("token", "project"), (error: Error) => {
      assert.ok(error instanceof GeminiVerificationRequiredError);
      assert.equal(error.verificationUrl, verificationUrl);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|challenge|flowName/);
      return true;
    });
  });
});
