import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * pi-plus.json is the single store. Each case gets an isolated PI_AGENT_DIR and
 * a reset cache, because the config is memoized per process.
 */
async function setup(files: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-config-"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(value), "utf8");
  }
  process.env.PI_AGENT_DIR = dir;
  delete process.env.PI_PLUS_CONFIG;

  const module = await import("../src/core/config.ts");
  module.resetConfigCache();
  return {
    module,
    dir,
    read: () => JSON.parse(readFileSync(join(dir, "pi-plus.json"), "utf8")),
    cleanup: () => {
      module.resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a fresh install writes all three sections", async () => {
  const { module, read, cleanup } = await setup();
  try {
    const config = module.readConfig();
    assert.deepEqual(Object.keys(config).sort(), ["env", "policy", "remote"]);
    assert.deepEqual(read().policy.requireApproval, config.policy.requireApproval);
    assert.deepEqual(config.remote.workers, []);
  } finally {
    cleanup();
  }
});

test("sections are independent, writing one preserves the others", async () => {
  const { module, read, cleanup } = await setup();
  try {
    module.updateConfig((config) => {
      config.env.AGENT_BOARD_NAME = "james";
    });
    module.updateConfig((config) => {
      config.remote.workers = [{ name: "gpu", ssh: "gpu" }];
    });
    module.updateConfig((config) => {
      config.policy.deny = ["xai/*"];
    });

    const onDisk = read();
    assert.equal(onDisk.env.AGENT_BOARD_NAME, "james");
    assert.equal(onDisk.remote.workers[0].name, "gpu");
    assert.deepEqual(onDisk.policy.deny, ["xai/*"]);
  } finally {
    cleanup();
  }
});

test("every legacy file folds into the right section", async () => {
  const { module, read, cleanup } = await setup({
    "model-quality-key.json": { artificialAnalysis: "aa_legacy" },
    "agent-board.json": { url: "ws://old:8787/ws", token: "tok", adminName: "james" },
    "model-policy.json": { autoApprove: ["anthropic/*"], requireApproval: ["openrouter/*"], deny: ["xai/*"] },
    "remote.json": { injectStatus: false, workers: [{ name: "hyperion", ssh: "hyperion" }] },
  });
  try {
    const config = module.readConfig();
    assert.equal(config.env.ARTIFICIAL_ANALYSIS_API_KEY, "aa_legacy");
    assert.equal(config.env.AGENT_BOARD_URL, "ws://old:8787/ws");
    assert.equal(config.env.AGENT_BOARD_NAME, "james");
    assert.deepEqual(config.policy.deny, ["xai/*"]);
    assert.equal(config.remote.workers[0].name, "hyperion");
    assert.equal(config.remote.injectStatus, false);
    assert.equal(read().env.AGENT_BOARD_TOKEN, "tok", "migration is persisted, not just in memory");
  } finally {
    cleanup();
  }
});

test("the oldest worker filename still migrates", async () => {
  const { module, cleanup } = await setup({
    "remote-workers.json": { workers: [{ name: "mac-mini", ssh: "mac-mini" }] },
  });
  try {
    assert.equal(module.readConfig().remote.workers[0].name, "mac-mini");
  } finally {
    cleanup();
  }
});

test("remote.json wins over the older remote-workers.json", async () => {
  const { module, cleanup } = await setup({
    "remote.json": { workers: [{ name: "newer", ssh: "newer" }] },
    "remote-workers.json": { workers: [{ name: "older", ssh: "older" }] },
  });
  try {
    const workers = module.readConfig().remote.workers;
    assert.equal(workers.length, 1);
    assert.equal(workers[0].name, "newer");
  } finally {
    cleanup();
  }
});

test("the intermediate env file folds in", async () => {
  const { module, cleanup } = await setup({
    "pi-plus.env.json": { ARTIFICIAL_ANALYSIS_API_KEY: "aa_from_env_file" },
  });
  try {
    assert.equal(module.readConfig().env.ARTIFICIAL_ANALYSIS_API_KEY, "aa_from_env_file");
  } finally {
    cleanup();
  }
});

test("existing unified values are never overwritten by legacy files", async () => {
  const { module, cleanup } = await setup({
    "pi-plus.json": {
      env: { ARTIFICIAL_ANALYSIS_API_KEY: "aa_current" },
      policy: { autoApprove: [], requireApproval: ["current/*"], deny: [] },
      remote: { workers: [{ name: "current", ssh: "current" }] },
    },
    "model-quality-key.json": { artificialAnalysis: "aa_legacy" },
    "remote.json": { workers: [{ name: "legacy", ssh: "legacy" }] },
  });
  try {
    const config = module.readConfig();
    assert.equal(config.env.ARTIFICIAL_ANALYSIS_API_KEY, "aa_current");
    assert.deepEqual(config.policy.requireApproval, ["current/*"]);
    assert.equal(config.remote.workers[0].name, "current");
  } finally {
    cleanup();
  }
});

test("legacy files are preserved so a downgrade still works", async () => {
  const { module, dir, cleanup } = await setup({
    "model-policy.json": { autoApprove: [], requireApproval: ["openrouter/*"], deny: [] },
    "remote.json": { workers: [] },
  });
  try {
    module.readConfig();
    assert.ok(existsSync(join(dir, "model-policy.json")));
    assert.ok(existsSync(join(dir, "remote.json")));
  } finally {
    cleanup();
  }
});

test("a corrupt config falls back to defaults rather than throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-config-"));
  writeFileSync(join(dir, "pi-plus.json"), "{ not json", "utf8");
  process.env.PI_AGENT_DIR = dir;
  try {
    const module = await import("../src/core/config.ts");
    module.resetConfigCache();
    const config = module.readConfig();
    assert.deepEqual(config.remote.workers, []);
    assert.ok(config.policy.requireApproval.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PI_PLUS_CONFIG redirects the whole store", async () => {
  const { module, dir, cleanup } = await setup();
  try {
    const custom = join(dir, "elsewhere.json");
    process.env.PI_PLUS_CONFIG = custom;
    module.resetConfigCache();
    module.readConfig();
    assert.ok(existsSync(custom));
  } finally {
    delete process.env.PI_PLUS_CONFIG;
    cleanup();
  }
});
