import test from "node:test";
import assert from "node:assert/strict";
import {
  accountProvider,
  accountProviders,
  registerAccountProvider,
  resetAccountProviders,
  routableProviders,
  type AccountProvider,
  type RoutingMode,
} from "../src/core/accounts/registry.ts";

function stub(id: string, withRouting = false): AccountProvider {
  let mode: RoutingMode = "standard";
  return {
    id,
    label: id.toUpperCase(),
    list: async () => [{ id: `${id}-1`, label: "Primary", enabled: true }],
    add: async (_ctx, label) => label,
    reauth: async (_ctx, accountId) => accountId,
    ...(withRouting
      ? {
          routing: {
            get: async () => mode,
            set: async (next: RoutingMode) => {
              mode = next;
              return mode;
            },
            describe: (value: RoutingMode) => `described ${value}`,
          },
        }
      : {}),
  };
}

test("providers register and resolve by id", () => {
  resetAccountProviders();
  registerAccountProvider(stub("anthropic"));
  assert.equal(accountProvider("anthropic")?.label, "ANTHROPIC");
  assert.equal(accountProvider("ANTHROPIC")?.id, "anthropic", "lookup is case-insensitive");
  assert.equal(accountProvider("nope"), undefined);
});

test("providers list in stable id order", () => {
  resetAccountProviders();
  registerAccountProvider(stub("openai-codex"));
  registerAccountProvider(stub("anthropic"));
  assert.deepEqual(accountProviders().map((p) => p.id), ["anthropic", "openai-codex"]);
});

test("re-registering the same id replaces rather than duplicates", () => {
  resetAccountProviders();
  registerAccountProvider(stub("anthropic"));
  registerAccountProvider(stub("anthropic"));
  assert.equal(accountProviders().length, 1);
});

test("only providers with routing support are routable", () => {
  resetAccountProviders();
  registerAccountProvider(stub("anthropic", true));
  registerAccountProvider(stub("plain", false));
  assert.deepEqual(routableProviders().map((p) => p.id), ["anthropic"]);
});

test("routing round-trips through the adapter", async () => {
  resetAccountProviders();
  registerAccountProvider(stub("anthropic", true));
  const routing = accountProvider("anthropic")!.routing!;
  assert.equal(await routing.get(), "standard");
  assert.equal(await routing.set("optimal"), "optimal");
  assert.equal(await routing.get(), "optimal");
  assert.equal(routing.describe("optimal"), "described optimal");
});

test("an empty registry is reported as empty, not thrown", () => {
  resetAccountProviders();
  assert.deepEqual(accountProviders(), []);
  assert.deepEqual(routableProviders(), []);
});

test("setEnabled is optional and reported through the account list", async () => {
  resetAccountProviders();
  const states = new Map([["a-1", true]]);
  registerAccountProvider({
    ...stub("toggleable"),
    list: async () => [...states].map(([id, enabled]) => ({ id, label: id, enabled })),
    setEnabled: async (id, enabled) => { states.set(id, enabled); },
  });
  registerAccountProvider(stub("fixed"));

  const toggleable = accountProvider("toggleable")!;
  assert.equal(typeof toggleable.setEnabled, "function");
  await toggleable.setEnabled!("a-1", false);
  assert.equal((await toggleable.list())[0].enabled, false, "disabling is visible in the list");
  await toggleable.setEnabled!("a-1", true);
  assert.equal((await toggleable.list())[0].enabled, true, "and is reversible");

  assert.equal(accountProvider("fixed")!.setEnabled, undefined, "providers may omit it entirely");
});
