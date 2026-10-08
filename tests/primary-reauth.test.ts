import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { resetConfigCache } from "../src/core/config.ts";
import { builtinProvider } from "../src/providers/shared/builtin.ts";
import { savePrimaryLogin } from "../src/providers/shared/accounts/primary.ts";
import { CODEX_SPEC, codexAccounts } from "../src/providers/codex/provider.ts";
import { loadCodexAccounts } from "../src/providers/codex/store.ts";
import { fetchCodexRows } from "../src/providers/codex/usage.ts";
import { registerAccountCommands } from "../src/domains/subscriptions/accounts.ts";
import { registerAccountProvider, resetAccountProviders, type AccountContext } from "../src/providers/shared/accounts/registry.ts";

/** A Codex-shaped JWT: identity comes from the ChatGPT account claim. */
const jwt = (account: string, nonce: string) => ["h", Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "pro" }, nonce,
})).toString("base64url"), "s"].join(".");
const login = (account: string, nonce: string) => ({ type: "oauth" as const, access: jwt(account, nonce), refresh: `r-${nonce}`, expires: Date.now() + 3_600_000 });

function sandbox(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "pi-primary-reauth-"));
  const names = ["PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_PLUS_CONFIG", "PI_PLUS_CODEX_ACCOUNTS_FILE"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_AGENT_DIR: dir,
    PI_PLUS_CONFIG: join(dir, "pi-plus.json"), PI_PLUS_CODEX_ACCOUNTS_FILE: join(dir, "codex-accounts.json") });
  resetConfigCache();
  const createProvider = CODEX_SPEC.createProvider;
  t.after(() => {
    CODEX_SPEC.createProvider = createProvider;
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "openai-codex": login("acct-1", "dead"), other: { type: "api_key", key: "keep" } }));
  /** Only the browser step is stubbed; persistence is pi's real credential store. */
  const signInAs = (credential: ReturnType<typeof login>) => {
    const base = builtinProvider("openai-codex");
    CODEX_SPEC.createProvider = () => ({ ...base, auth: { ...base.auth, oauth: { ...base.auth.oauth!, login: async () => credential } } }) as any;
  };
  const notices: string[] = [];
  const ctx: AccountContext = { hasUI: true, openBrowser: async () => {},
    ui: { confirm: async () => true, input: async () => undefined, select: async () => undefined, notify: (text) => notices.push(text) } };
  const stored = () => readStoredCredential("openai-codex") as any;
  return { authPath, signInAs, ctx, notices, stored };
}

test("adding the primary's own Codex account reauthorizes the primary instead of creating a duplicate", async (t) => {
  const h = sandbox(t);
  const fresh = login("acct-1", "fresh");
  h.signInAs(fresh);
  assert.equal(await codexAccounts.add(h.ctx, "main"), undefined);
  assert.deepEqual(loadCodexAccounts().accounts, [], "no duplicate account");
  assert.equal(h.stored().access, fresh.access, "the primary now holds the new login");
  assert.deepEqual(JSON.parse(readFileSync(h.authPath, "utf8")).other, { type: "api_key", key: "keep" });
  assert.match(h.notices.join("\n"), /reauthorized instead of added/);

  const second = login("acct-2", "second");
  h.signInAs(second);
  assert.equal(await codexAccounts.add(h.ctx, "Second"), "Second", "a different account is still added");
  assert.equal(loadCodexAccounts().accounts.length, 1);
  assert.equal(h.stored().access, fresh.access, "and leaves the primary alone");
});

test("reauthorizing the Codex primary replaces pi's login without touching added accounts", async (t) => {
  const h = sandbox(t);
  h.signInAs(login("acct-2", "second"));
  await codexAccounts.add(h.ctx, "Second");
  const renewed = login("acct-1", "renewed");
  h.signInAs(renewed);
  assert.equal(await codexAccounts.reauth(h.ctx, "main"), "Primary");
  assert.equal(h.stored().access, renewed.access);
  assert.equal(loadCodexAccounts().accounts[0].access, jwt("acct-2", "second"));
});

test("/accounts reauth offers the primary even when no account was added", async (t) => {
  sandbox(t);
  const reauthed: string[] = [];
  const offered: string[][] = [];
  resetAccountProviders();
  t.after(resetAccountProviders);
  registerAccountProvider({ ...codexAccounts, reauth: async (_ctx, id) => { reauthed.push(id); return "Primary"; } });
  let handler: any;
  registerAccountCommands({ registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any);
  const notices: string[] = [];
  await handler("reauth openai-codex", { hasUI: true, ui: {
    select: async (_title: string, labels: string[]) => { offered.push(labels); return labels[0]; },
    notify: (text: string) => notices.push(text),
  } });
  assert.match(offered[0][0], /^Primary\b.*primary/);
  assert.deepEqual(reauthed, ["main"]);
  assert.doesNotMatch(notices.join("\n"), /Add one with/);
});

test("Claude's primary is saved through pi's store as well", async (t) => {
  const h = sandbox(t);
  await savePrimaryLogin(builtinProvider("anthropic"), { type: "oauth", access: "sk-ant-oat-new", refresh: "r", expires: Date.now() + 3_600_000 });
  const saved = JSON.parse(readFileSync(h.authPath, "utf8"));
  assert.equal(saved.anthropic.access, "sk-ant-oat-new");
  assert.equal(saved["openai-codex"].access, jwt("acct-1", "dead"), "other logins are preserved");
});

test("a rejected Codex login says how to fix it", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unauthorized", { status: 401 }));
  const result = await fetchCodexRows(undefined, { readCredential: () => login("acct-1", "dead") });
  assert.equal(result.error, "Codex: login rejected, run /accounts reauth openai-codex");
});
