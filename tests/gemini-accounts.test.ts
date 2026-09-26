import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { AccountContext } from "../src/core/accounts/registry.ts";
import { loadOAuthPool, resetOAuthPoolCache, saveOAuthAccount } from "../src/core/accounts/oauth-pool.ts";
import { encodeApiKey } from "../src/core/gemini/credentials.ts";
import { STATIC_MODELS } from "../src/core/gemini/models.ts";
import { confirmGeminiAccess } from "../src/core/gemini/oauth.ts";
import {
  GEMINI_SPEC,
  CATALOG_TTL_MS,
  geminiAccounts,
  createGeminiProvider,
} from "../src/domains/subscriptions/providers/gemini.ts";
import { chooseCredential } from "../src/domains/subscriptions/providers/oauth-pool.ts";

const PROVIDER = "gemini";

async function withPool(run: () => void | Promise<void>): Promise<void> {
  const path = join(tmpdir(), `pi-plus-gemini-${randomUUID()}.json`);
  process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE = path;
  resetOAuthPoolCache();
  try {
    await run();
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_OAUTH_ACCOUNTS_FILE;
    resetOAuthPoolCache();
  }
}

function account(id: string, email: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    id,
    label: id,
    access: `ya29.${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 3_600_000,
    projectId: `project-${id}`,
    email,
    addedAt: 1,
    ...overrides,
  };
}

/** Minimal `/accounts` bridge that answers every prompt the adapter can ask. */
function stubContext(credential: unknown): AccountContext {
  GEMINI_SPEC.createProvider = () => ({ auth: { oauth: { login: async () => credential } } }) as any;
  return {
    hasUI: true,
    ui: { input: async () => "name", select: async () => undefined, confirm: async () => true, notify: () => {} },
    openBrowser: async () => {},
  };
}

test("Gemini is a registered account provider with routing", () => {
  assert.equal(geminiAccounts.id, PROVIDER);
  assert.equal(geminiAccounts.label, "Gemini");
  assert.ok(geminiAccounts.routing, "Gemini must appear under /accounts routing");
  assert.ok(geminiAccounts.setEnabled && geminiAccounts.rename);
});

test("accounts retain their chosen names and use email only for identity", async () => {
  await withPool(async () => {
    saveOAuthAccount(PROVIDER, account("one", "Work@Example.com"));
    saveOAuthAccount(PROVIDER, account("two", "personal@example.com"));

    const listed = await geminiAccounts.list();
    assert.deepEqual(listed.map((item) => item.identity), ["email:work@example.com", "email:personal@example.com"]);
    assert.deepEqual(listed.map((item) => item.label), ["one", "two"]);
    assert.equal(GEMINI_SPEC.describeAccount!(account("fallback-id", "private@example.com", { label: "" })), "fallback");
    await geminiAccounts.rename!(listed[1].id, "Work");
    const renamed = (await geminiAccounts.list())[1];
    assert.equal(renamed.label, "Work");
    assert.equal(renamed.identity, "email:personal@example.com");
  });
});

test("signing in twice with the same Google account is rejected", async () => {
  const original = GEMINI_SPEC.createProvider;
  try {
    await withPool(async () => {
      await geminiAccounts.add(stubContext(account("one", "work@example.com")), "Work");
      // A fresh login for the same account has a different opaque token; only
      // the email can recognise it as a duplicate.
      const rotated = stubContext({ ...account("one", "WORK@example.com"), access: "ya29.rotated" });
      await assert.rejects(() => geminiAccounts.add(rotated, "Duplicate"), /already saved/i);
      assert.equal(loadOAuthPool(PROVIDER).accounts.length, 1);
    });
  } finally {
    GEMINI_SPEC.createProvider = original;
  }
});

test("a second Google account joins the pool with its project", async () => {
  const original = GEMINI_SPEC.createProvider;
  try {
    await withPool(async () => {
      assert.equal(await geminiAccounts.add(stubContext(account("fresh", "second@example.com")), "Second"), "Second");
      const stored = loadOAuthPool(PROVIDER).accounts;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].identity, "email:second@example.com");
      assert.equal((stored[0] as { projectId?: string }).projectId, "project-fresh");

      const primary = { type: "oauth" as const, access: "ya29.primary", refresh: "r", expires: Date.now() + 60_000 };
      const chosen = chooseCredential(GEMINI_SPEC, primary);
      assert.ok(chosen.id === "main" || chosen.account !== undefined);
    });
  } finally {
    GEMINI_SPEC.createProvider = original;
  }
});

test("reauth opens verification and preserves saved credentials until access is confirmed", async () => {
  const original = GEMINI_SPEC.createProvider;
  const originalFetch = globalThis.fetch;
  try {
    await withPool(async () => {
      const old = account("one", "work@example.com");
      saveOAuthAccount(PROVIDER, old);
      const updated = { ...old, access: "ya29.updated" };
      GEMINI_SPEC.createProvider = () => ({ auth: { oauth: {
        login: (interaction: Parameters<typeof confirmGeminiAccess>[1]) => confirmGeminiAccess(updated, interaction),
      } } }) as any;
      const opened: string[] = [];
      const ctx: AccountContext = {
        hasUI: true,
        ui: { input: async () => undefined, select: async () => "Cancel sign-in", confirm: async () => true, notify: () => {} },
        openBrowser: async (url) => { opened.push(url); },
      };
      globalThis.fetch = async () => Response.json({ error: {
        message: "Verify your account to continue.",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo", domain: "cloudcode-pa.googleapis.com",
          reason: "VALIDATION_REQUIRED", metadata: { validation_url: "https://accounts.google.com/signin/continue" },
        }],
      } }, { status: 403 });
      await assert.rejects(geminiAccounts.reauth(ctx, "one"), /sign-in cancelled/);
      assert.deepEqual(opened, ["https://accounts.google.com/signin/continue"]);
      assert.equal(loadOAuthPool(PROVIDER).accounts[0].access, old.access);

      globalThis.fetch = async () => Response.json({ buckets: [] });
      assert.equal(await geminiAccounts.reauth(ctx, "one"), "one");
      assert.equal(loadOAuthPool(PROVIDER).accounts[0].access, updated.access);
    });
  } finally {
    GEMINI_SPEC.createProvider = original;
    globalThis.fetch = originalFetch;
  }
});

test("quota is attributed by unwrapping the project-carrying apiKey", () => {
  assert.equal(GEMINI_SPEC.accessTokenOf!(encodeApiKey({ token: "ya29.one", projectId: "p" })), "ya29.one");
  // An unreadable key must degrade to "unknown account", never throw inside onResponse.
  assert.equal(GEMINI_SPEC.accessTokenOf!("not-json"), undefined);
});

// --- Live catalogue ----------------------------------------------------------

const credential = { type: "oauth" as const, access: "ya29.primary", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj" };

function refreshContext(overrides: Partial<RefreshModelsContext> = {}) {
  const published: ModelsPublication[] = [];
  const context: RefreshModelsContext = {
    credential,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => { publication.update?.(); published.push(publication); return true; },
    ...overrides,
  };
  return { context, published };
}

async function withModelList(models: Record<string, unknown> | "fail", run: (calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push(`${String(input)} ${init?.body ?? ""}`);
    if (models === "fail") return new Response("{}", { status: 503 });
    return Response.json({ models });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const liveModels = { "gemini-9-flash-low": { displayName: "Gemini 9 Flash (Low)" }, "gemini-9-flash-high": { displayName: "Gemini 9 Flash (High)" } };

test("before any refresh the static catalogue is served", () => {
  assert.deepEqual(createGeminiProvider().getModels().map((model) => model.id), STATIC_MODELS.map((model) => model.id));
});

test("a refresh publishes newly enabled models and persists them for the next start", async () => {
  const provider = createGeminiProvider();
  const { context, published } = refreshContext();
  await withModelList(liveModels, async (calls) => {
    await provider.refreshModels!(context);
    assert.ok(calls.every((call) => call.includes("fetchAvailableModels") && call.includes("\"project\":\"proj\"")));
  });

  assert.ok(provider.getModels().some((model) => model.id === "gemini-9-flash"));
  const persisted = published.find((publication) => publication.persist)!.persist!;
  assert.ok(persisted.models.some((model) => model.id === "gemini-9-flash"));
  assert.ok(typeof persisted.checkedAt === "number");
});

test("a stored catalogue is restored offline and a fresh one is not refetched", async () => {
  const stored = { models: [{ ...STATIC_MODELS[0], id: "gemini-9-flash" }], checkedAt: Date.now() };
  for (const overrides of [{ allowNetwork: false }, {}]) {
    const provider = createGeminiProvider();
    await withModelList(liveModels, async (calls) => {
      await provider.refreshModels!(refreshContext({ stored, ...overrides }).context);
      assert.equal(calls.length, 0, "no network inside the freshness window");
    });
    assert.ok(provider.getModels().some((model) => model.id === "gemini-9-flash"));
  }
});

test("a stale catalogue, or an explicit refresh, asks the backend again", async () => {
  for (const [stored, force] of [
    [{ models: [], checkedAt: Date.now() - CATALOG_TTL_MS - 1 }, false],
    [{ models: [], checkedAt: Date.now() }, true],
  ] as const) {
    await withModelList(liveModels, async (calls) => {
      await createGeminiProvider().refreshModels!(refreshContext({ stored, force }).context);
      assert.ok(calls.length > 0);
    });
  }
});

test("a failed refresh keeps the last catalogue; only an explicit one reports it", async () => {
  const provider = createGeminiProvider();
  const stored = { models: [{ ...STATIC_MODELS[0], id: "gemini-9-flash" }], checkedAt: 0 };
  await withModelList("fail", async () => {
    await provider.refreshModels!(refreshContext({ stored }).context);
    assert.ok(provider.getModels().some((model) => model.id === "gemini-9-flash"));
    await assert.rejects(() => provider.refreshModels!(refreshContext({ stored, force: true }).context), /model list/);
  });
});

test("without an OAuth login there is nothing to ask", async () => {
  await withModelList(liveModels, async (calls) => {
    await createGeminiProvider().refreshModels!(refreshContext({ credential: undefined }).context);
    assert.equal(calls.length, 0);
  });
});
