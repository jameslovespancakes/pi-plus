import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resetConfigCache } from "../src/core/config.ts";
import { primaryAccountEnabled, setPrimaryAccountEnabled } from "../src/providers/shared/accounts/primary.ts";
import { primaryOAuth } from "../src/providers/shared/quota/source.ts";
import { builtinProvider } from "../src/providers/shared/builtin.ts";
import { registerPooledOAuthProvider } from "../src/providers/shared/serving.ts";
import { CODEX_SPEC } from "../src/providers/codex/provider.ts";
import { openAccountsPicker } from "../src/domains/subscriptions/accounts-picker.ts";
import { registerAccountCommands } from "../src/domains/subscriptions/accounts.ts";
import { registerAccountProvider, resetAccountProviders } from "../src/providers/shared/accounts/registry.ts";
import { model, message, response } from "./fixtures/provider-stream.ts";

async function fixture(t: any, primary: "expired" | "fresh" | "absent" | "api" = "expired", oauthOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-primary-toggle-"));
  const previous = { config: process.env.PI_PLUS_CONFIG, agent: process.env.PI_AGENT_DIR, nativeAgent: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_PLUS_CONFIG = join(dir, "pi-plus.json");
  process.env.PI_AGENT_DIR = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  resetConfigCache();
  t.after(() => {
    if (previous.config === undefined) delete process.env.PI_PLUS_CONFIG; else process.env.PI_PLUS_CONFIG = previous.config;
    if (previous.agent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previous.agent;
    if (previous.nativeAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.nativeAgent;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });
  const authPath = join(dir, "auth.json");
  const original = primary === "absent" ? {} : { anthropic: primary === "api" ? { type: "api_key", key: "primary-key" }
    : { type: "oauth", access: "primary", refresh: "primary-refresh", expires: primary === "fresh" ? Date.now() + 3_600_000 : 0 } };
  writeFileSync(authPath, JSON.stringify(original));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  const base = builtinProvider("anthropic");
  const sent: string[] = [];
  let primaryRefreshes = 0;
  const accounts = [{ id: "secondary", label: "Secondary", type: "oauth" as const, access: "secondary", refresh: "secondary-refresh", expires: Date.now() + 3_600_000, enabled: true, addedAt: 0 }];
  const stream = (_model: any, _context: any, options: any) => { sent.push(options.apiKey); return response(message()); };
  const provider = { ...base, auth: { ...base.auth,
    apiKey: oauthOnly ? undefined : { ...base.auth.apiKey!, check: async () => undefined, resolve: async ({ credential }: any) => credential ? { auth: { apiKey: credential.key } } : undefined },
    oauth: { ...base.auth.oauth!,
      refresh: async (value: any) => { primaryRefreshes++; return { ...value, access: "refreshed-primary", expires: Date.now() + 3_600_000 }; },
      toAuth: async (value: any) => ({ apiKey: value.access }),
    },
  }, stream, streamSimple: stream };
  registerPooledOAuthProvider({ registerProvider: (value: any) => runtime.registerNativeProvider(value) } as any, {
    id: "anthropic", label: "Claude", createProvider: () => provider as any,
    store: { load: () => ({ mode: "sequential", accounts }), primaryQuota: () => undefined, saveMode() {},
      saveAccount: (value) => { Object.assign(accounts.find((account) => account.id === value.id)!, value); },
    },
  }, { sleep: async () => { assert.fail("healthy enabled sidecar needs no retry delay"); } });
  const run = () => runtime.streamSimple({ ...model, provider: "anthropic" }, { messages: [{ role: "user", content: "test", timestamp: 1 }] }).result();
  return { dir, authPath, original, runtime, registry: new ModelRegistry(runtime), accounts, sent, run, primaryRefreshes: () => primaryRefreshes };
}

test("disabling an expired primary bypasses its refresh, serves an enabled login and leaves pi credentials intact", async (t) => {
  const h = await fixture(t);
  setPrimaryAccountEnabled("anthropic", false);
  assert.equal(primaryAccountEnabled("anthropic"), false);
  assert.ok(await h.registry.getProviderAuth("anthropic"), "use pi's real extension facade");
  assert.equal((await h.run()).stopReason, "stop");
  assert.deepEqual(h.sent, ["secondary"]);
  assert.equal(h.primaryRefreshes(), 0);
  assert.deepEqual(JSON.parse(readFileSync(h.authPath, "utf8")), h.original);
  assert.equal(await primaryOAuth({ modelRegistry: h.registry }, "anthropic", () => { assert.fail("disabled primary must not be read for quota"); }), undefined);
  setPrimaryAccountEnabled("anthropic", true);
  assert.equal((await h.run()).stopReason, "stop");
  assert.equal(h.primaryRefreshes(), 1, "reenabling restores pi's normal refresh");
  assert.deepEqual(h.sent, ["secondary", "refreshed-primary"]);
});

test("removing a dead primary does not require creating a replacement primary or another account", async (t) => {
  const h = await fixture(t, "absent");
  assert.ok(await h.registry.getProviderAuth("anthropic"));
  assert.equal((await h.run()).stopReason, "stop");
  assert.deepEqual(h.sent, ["secondary"]);
  assert.equal(h.accounts.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(h.authPath, "utf8")), {}, "sidecar tokens are not copied into pi auth");
});

test("OAuth-only providers keep pi's native auth shape", async (t) => {
  const h = await fixture(t, "fresh", true);
  assert.equal(h.runtime.getProvider("anthropic")?.auth.apiKey, undefined, "no API-key handler is invented");
  const resolved = await h.registry.getProviderAuth("anthropic");
  assert.equal((await h.runtime.getAuth("anthropic", { apiKey: resolved!.auth.apiKey }))?.auth.apiKey, "primary");
});

test("Codex summarization resolves an explicit request key through the stored OAuth login", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-codex-compaction-"));
  const previous = { accounts: process.env.PI_PLUS_CODEX_ACCOUNTS_FILE, config: process.env.PI_PLUS_CONFIG };
  process.env.PI_PLUS_CODEX_ACCOUNTS_FILE = join(dir, "codex-accounts.json");
  process.env.PI_PLUS_CONFIG = join(dir, "pi-plus.json");
  t.after(() => {
    if (previous.accounts === undefined) delete process.env.PI_PLUS_CODEX_ACCOUNTS_FILE; else process.env.PI_PLUS_CODEX_ACCOUNTS_FILE = previous.accounts;
    if (previous.config === undefined) delete process.env.PI_PLUS_CONFIG; else process.env.PI_PLUS_CONFIG = previous.config;
    rmSync(dir, { recursive: true, force: true });
  });
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: "codex-primary", refresh: "r", expires: Date.now() + 3_600_000 } }));
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  registerPooledOAuthProvider({ registerProvider: (value: any) => runtime.registerNativeProvider(value) } as any, CODEX_SPEC);
  const resolved = await new ModelRegistry(runtime).getProviderAuth("openai-codex");
  assert.equal(resolved?.auth.apiKey, "codex-primary");
  // pi's compaction passes the resolved key back as an explicit request key.
  const explicit = await runtime.getAuth("openai-codex", { apiKey: resolved!.auth.apiKey });
  assert.equal(explicit?.auth.apiKey, "codex-primary", "must not become 'Provider is not configured'");
});

test("all disabled fails closed instead of silently using the primary", async (t) => {
  const h = await fixture(t, "fresh");
  setPrimaryAccountEnabled("anthropic", false);
  h.accounts[0].enabled = false;
  await assert.rejects(() => h.registry.getProviderAuth("anthropic"), /No enabled Claude accounts/);
  assert.deepEqual(h.sent, []);
});

test("native API-key primaries also honor the toggle without losing their saved key", async (t) => {
  const h = await fixture(t, "api");
  assert.equal((await h.run()).stopReason, "stop");
  setPrimaryAccountEnabled("anthropic", false);
  assert.equal((await h.run()).stopReason, "stop");
  assert.deepEqual(h.sent, ["primary-key", "secondary"]);
  assert.deepEqual(JSON.parse(readFileSync(h.authPath, "utf8")), h.original);
});

test("real /accounts collapses primary's duplicate and toggles both credentials before native routing", async (t) => {
  const h = await fixture(t, "fresh");
  const duplicate = { ...h.accounts[0], id: "personal", label: "Personal", access: "duplicate" };
  h.accounts.push(duplicate);
  resetAccountProviders();
  t.after(resetAccountProviders);
  let fail = false;
  registerAccountProvider({
    id: "anthropic", label: "Claude", identify: () => "personal-user",
    list: async () => h.accounts.map((account) => ({ ...account, identity: account.id === "personal" ? "personal-user" : "secondary-user" })),
    add: async () => undefined, reauth: async () => undefined,
    setEnabled: async (id, enabled) => {
      if (fail) throw new Error("test save failed");
      h.accounts.find((account) => account.id === id)!.enabled = enabled;
    },
  });
  let handler: any;
  registerAccountCommands({ registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any);
  let component: any;
  let mounted!: () => void;
  const ready = new Promise<void>((resolve) => { mounted = resolve; });
  let onRender = () => {};
  const notices: string[] = [];
  const open = handler("", { hasUI: true, modelRegistry: h.registry, ui: {
    custom: (factory: any) => new Promise((resolve) => {
      component = factory({ requestRender: () => onRender() }, { fg: (_c: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
      mounted();
    }), notify: (text: string) => notices.push(text),
  } });
  await ready;
  const text = component.render(100).join("\n");
  assert.equal((text.match(/Claude/g) ?? []).length, 2, "the actual SettingsList has two Claude rows, not three");
  assert.match(text, /Personal/);
  assert.match(text, /Secondary/);
  const toggle = async () => {
    const rendered = new Promise<void>((resolve) => { onRender = resolve; });
    component.handleInput("\r");
    await rendered;
  };
  await toggle();
  assert.equal(primaryAccountEnabled("anthropic"), false);
  assert.equal(duplicate.enabled, false, "the hidden duplicate cannot bypass the disabled account");
  assert.equal((await h.run()).stopReason, "stop");
  assert.deepEqual(h.sent, ["secondary"]);
  fail = true;
  await toggle();
  assert.equal(primaryAccountEnabled("anthropic"), false, "a partial toggle failure restores the primary flag");
  assert.equal(duplicate.enabled, false);
  assert.match(notices[0], /test save failed/);
  fail = false;
  await toggle();
  assert.equal(primaryAccountEnabled("anthropic"), true);
  assert.equal(duplicate.enabled, true);
  assert.equal((await h.run()).stopReason, "stop");
  assert.deepEqual(h.sent, ["secondary", "primary"]);
  component.handleInput("\u001b");
  await open;
});

test("the original picker toggles primary in place, without adding actions or badges", async () => {
  let component: any;
  let mounted!: () => void;
  const ready = new Promise<void>((resolve) => { mounted = resolve; });
  let rendered: (() => void) | undefined;
  const update = new Promise<void>((resolve) => { rendered = resolve; });
  const calls: string[] = [];
  const picker = openAccountsPicker({ ui: { custom: (factory: any) => new Promise((resolve) => {
    component = factory({ requestRender: () => rendered?.() }, { fg: (_c: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
    mounted();
  }), notify: () => assert.fail("no warning for toggling a primary") } }, {
    rows: async () => [{ id: "anthropic:main", providerId: "anthropic", providerLabel: "Claude", label: "Primary", state: "enabled", primary: true }],
    toggle: async (provider, id) => { calls.push(`${provider}:${id}`); return "disabled"; },
  });
  await ready;
  component.handleInput("\r");
  await update;
  const text = component.render(100).join("\n");
  assert.deepEqual(calls, ["anthropic:main"]);
  assert.match(text, /Disabled/);
  assert.doesNotMatch(text, /Reauthorize|Remove account|Refresh credential|login\?/);
  component.handleInput("\u001b");
  assert.equal(await picker, undefined);
});
