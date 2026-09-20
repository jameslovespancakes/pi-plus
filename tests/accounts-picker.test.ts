import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRows, providerAccounts } from "../src/domains/subscriptions/accounts-picker.ts";
import { registerAccountCommands } from "../src/domains/subscriptions/accounts.ts";
import {
  registerAccountProvider,
  resetAccountProviders,
  type AccountProvider,
} from "../src/core/accounts/registry.ts";

function provider(accounts: Awaited<ReturnType<AccountProvider["list"]>>): AccountProvider {
  return {
    id: "openai-codex",
    label: "Codex",
    list: async () => accounts,
    add: async () => undefined,
    reauth: async () => undefined,
  };
}

const primary = {
  id: "main",
  label: "Primary",
  enabled: true,
  primary: true,
} as const;

test("account rows include pi's primary account before added accounts", async () => {
  const codex = provider([{ id: "work", label: "Work (pro)", enabled: true }]);
  const rows = await accountRows([codex], async () => primary);

  assert.deepEqual(rows.map((row) => ({ id: row.id, label: row.label, primary: row.primary })), [
    { id: "openai-codex:main", label: "Primary", primary: true },
    { id: "openai-codex:work", label: "Work (pro)", primary: undefined },
  ]);
  assert.equal(rows[0]?.detail, "primary · managed by pi auth");
});

test("an account already identified as primary is not duplicated", async () => {
  const existing = { ...primary, label: "Existing primary" };
  const accounts = await providerAccounts(provider([existing]), async () => primary);

  assert.deepEqual(accounts, [existing]);
});

test("a sidecar login matching the primary identity is deduplicated", async () => {
  const duplicate = { id: "personal", label: "Personal", enabled: true, identity: "user-1" };
  const secondary = { id: "work", label: "Work", enabled: true, identity: "user-2" };
  const accounts = await providerAccounts(provider([duplicate, secondary]), async () => ({
    ...primary,
    identity: "user-1",
  }));

  assert.deepEqual(accounts, [{ ...primary, identity: "user-1" }, secondary]);
});

test("duplicate sidecar logins collapse even when no primary credential exists", async () => {
  const first = { id: "one", label: "Personal", enabled: true, identity: "user-1" };
  const duplicate = { id: "two", label: "Also personal", enabled: true, identity: "user-1" };
  const accounts = await providerAccounts(provider([first, duplicate]));

  assert.deepEqual(accounts, [first]);
});

test("primary lookup failures do not hide added accounts", async () => {
  const added = { id: "personal", label: "Personal", enabled: false };
  const accounts = await providerAccounts(provider([added]), async () => {
    throw new Error("auth.json unreadable");
  });

  assert.deepEqual(accounts, [added]);
});

test("headless /accounts reads the primary Codex login from pi auth", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-plus-accounts-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeFileSync(join(directory, "auth.json"), JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "primary-token",
      refresh: "primary-refresh",
      expires: Date.now() + 60_000,
    },
  }));

  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const notifications: string[] = [];
  try {
    resetAccountProviders();
    registerAccountProvider(provider([{ id: "work", label: "Work", enabled: true }]));
    registerAccountCommands({
      registerCommand(name: string, command: any) {
        if (name === "accounts") handler = command.handler;
      },
    } as any);

    assert.ok(handler);
    await handler("", {
      hasUI: false,
      ui: { notify: (message: string) => notifications.push(message) },
    });

    assert.match(notifications.join("\n"), /Primary\s+active · primary/);
    assert.match(notifications.join("\n"), /Work\s+active/);
  } finally {
    resetAccountProviders();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(directory, { recursive: true, force: true });
  }
});
