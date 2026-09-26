import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each case gets an independent session policy and throwaway persistent config. */
async function loadPolicyModule(policy: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-policy-"));
  writeFileSync(join(dir, "pi-plus.json"), JSON.stringify({ policy }), "utf8");
  process.env.PI_AGENT_DIR = dir;
  const config = await import("../src/core/config.ts");
  config.resetConfigCache();
  const exports = await import("../src/core/policy/policy.ts");
  const module: any = Object.assign(new exports.ProviderPolicy(), { loadPolicy: exports.loadPolicy, gatedProviders: exports.gatedProviders });
  return { module, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const BASE = {
  autoApprove: ["anthropic/*"],
  requireApproval: ["openrouter/*", "xai/*"],
  deny: [],
};

test("autoApprove patterns are allowed without prompting", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    assert.equal(module.checkModel("anthropic", "claude-opus-5").allowed, true);
    assert.equal(module.checkModel("anthropic", "claude-opus-5").reason, "auto");
  } finally {
    cleanup();
  }
});

test("providers outside every pattern are allowed", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    assert.equal(module.checkModel("ollama", "llama3").allowed, true);
  } finally {
    cleanup();
  }
});

test("requireApproval blocks until the provider is approved", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    const blocked = module.checkModel("openrouter", "glm-5");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "needs-approval");
    assert.equal(blocked.message, "OpenRouter is Off for this session. Open /provider and choose On or On (ZDR).");
    assert.equal(module.checkModel("openrouter", "stealth/space-bunny-alpha").message, blocked.message, "free models must not be described as pay-per-token");
    assert.equal(module.checkModel("xai", "model").message, "xai is Off for this session. Enable it in /provider.");

    module.approve("openrouter");
    assert.equal(module.checkModel("openrouter", "glm-5").allowed, true);
    module.revoke("openrouter");
    assert.equal(module.checkModel("openrouter", "glm-5").allowed, false);
  } finally {
    cleanup();
  }
});

test("toggleApproval flips state and reports the result", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    assert.equal(module.toggleApproval("openrouter"), true, "first toggle approves");
    assert.equal(module.isApproved("openrouter"), true);
    assert.equal(module.toggleApproval("openrouter"), false, "second toggle revokes");
    assert.equal(module.isApproved("openrouter"), false);
  } finally {
    cleanup();
  }
});

test("gatedProviders derives from the policy file, deduplicated and sorted", async () => {
  const { module, cleanup } = await loadPolicyModule({
    ...BASE,
    requireApproval: ["xai/*", "openrouter/*", "openrouter/specific-model", "*"],
  });
  try {
    assert.deepEqual(module.gatedProviders(), ["openrouter", "xai"], "bare wildcard is not a provider");
  } finally {
    cleanup();
  }
});

test("approvalStates reports one row per gated provider", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    module.approve("openrouter");
    const states = module.approvalStates();
    assert.deepEqual(states.map((s: any) => s.provider), ["openrouter", "xai"]);
    assert.equal(states[0].approved, true);
    assert.equal(states[0].until, undefined, "a session grant has no expiry to show");
    assert.equal(states[1].approved, false);
  } finally {
    cleanup();
  }
});

test("a timed approval expires", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    module.approve("openrouter", -1);
    assert.equal(module.checkModel("openrouter", "glm-5").allowed, false, "already past its window");
    assert.equal(module.approvalStates()[0].approved, false);
  } finally {
    cleanup();
  }
});

test("deny wins over approval", async () => {
  const { module, cleanup } = await loadPolicyModule({ ...BASE, deny: ["openrouter/*"] });
  try {
    module.approve("openrouter");
    const decision = module.checkModel("openrouter", "glm-5");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "denied");
  } finally {
    cleanup();
  }
});

test("policy has no budget surface left", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    assert.equal(module.recordSpend, undefined);
    assert.equal(module.spend, undefined);
    assert.equal(module.loadPolicy().meteredBudgetUsd, undefined);
    assert.doesNotMatch(module.policySummary(), /budget|spent|\$/i);
  } finally {
    cleanup();
  }
});

test("a missing config is created from defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-policy-"));
  process.env.PI_AGENT_DIR = dir;
  try {
    const config = await import("../src/core/config.ts");
    config.resetConfigCache();
    const module = await import(`../src/core/policy/policy.ts?case=${Math.random()}`);
    const loaded = module.loadPolicy();
    const written = JSON.parse(readFileSync(join(dir, "pi-plus.json"), "utf8"));
    assert.deepEqual(written.policy, loaded);
    assert.equal("meteredBudgetUsd" in written.policy, false);
    assert.deepEqual(Object.keys(written).sort(), ["env", "policy", "remote"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenRouter cycles Off, On, ZDR, Off without persisting a grant", async () => {
  const { module, dir, cleanup } = await loadPolicyModule(BASE);
  try {
    const before = readFileSync(join(dir, "pi-plus.json"), "utf8");
    assert.equal(module.providerState("openrouter"), "blocked");
    assert.equal(module.toggleProvider("openrouter"), "approved");
    assert.equal(module.openRouterZdrRequired(), false);
    assert.equal(module.toggleProvider("openrouter"), "zdr");
    assert.equal(module.openRouterZdrRequired(), true);
    assert.equal(module.checkModel("openrouter", "model").allowed, true);
    assert.match(module.policySummary(), /openrouter \(ZDR\)/);
    assert.equal(module.toggleProvider("openrouter"), "blocked");
    assert.equal(module.openRouterZdrRequired(), false);
    assert.equal(module.checkModel("openrouter", "model").allowed, false);
    assert.equal(readFileSync(join(dir, "pi-plus.json"), "utf8"), before);
    assert.equal(module.toggleProvider("xai"), "approved");
    assert.equal(module.toggleProvider("xai"), "blocked", "other toggles remain binary");
  } finally { cleanup(); }
});

test("explicit OpenRouter Off overrides auto-approval and normal On clears only the runtime ZDR choice", async () => {
  const { module, cleanup } = await loadPolicyModule({ ...BASE, autoApprove: ["*/*"], requireApproval: [] });
  try {
    assert.equal(module.providerState("openrouter"), "auto");
    assert.equal(module.toggleProvider("openrouter"), "zdr");
    assert.equal(module.toggleProvider("openrouter"), "blocked");
    assert.equal(module.checkModel("openrouter", "model").allowed, false);
    module.approveOpenRouterZdr();
    module.approve("openrouter");
    assert.equal(module.providerState("openrouter"), "approved");
    assert.equal(module.openRouterZdrRequired(), false);
    module.approve("openrouter", -1);
    assert.equal(module.checkModel("openrouter", "model").allowed, false);
  } finally { cleanup(); }
});

test("provider grants and ZDR mode are isolated and reset between sessions", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    const { ProviderPolicy } = await import("../src/core/policy/policy.ts");
    const other = new ProviderPolicy();
    module.approveOpenRouterZdr();
    assert.equal(other.providerState("openrouter"), "blocked");
    assert.equal(other.openRouterZdrRequired(), false);
    module.reset();
    assert.equal(module.providerState("openrouter"), "blocked");
    assert.equal(module.openRouterZdrRequired(), false);
  } finally { cleanup(); }
});

test("ZDR approval cannot override an explicit policy denial", async () => {
  const { module, cleanup } = await loadPolicyModule({ ...BASE, deny: ["openrouter/*"] });
  try {
    module.approveOpenRouterZdr();
    assert.equal(module.providerState("openrouter"), "denied");
    assert.equal(module.toggleProvider("openrouter"), "denied");
    assert.equal(module.checkModel("openrouter", "model").allowed, false);
  } finally { cleanup(); }
});

test("policySummary renders without throwing", async () => {
  const { module, cleanup } = await loadPolicyModule(BASE);
  try {
    assert.equal(typeof module.policySummary(), "string");
  } finally {
    cleanup();
  }
});
