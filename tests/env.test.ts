import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["ARTIFICIAL_ANALYSIS_API_KEY", "AGENT_BOARD_URL", "AGENT_BOARD_TOKEN", "AGENT_BOARD_NAME"] as const;

/** Each case needs a clean PI_AGENT_DIR, a fresh module, and no stray real env. */
async function setup(files: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-env-"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(value), "utf8");
  }
  process.env.PI_AGENT_DIR = dir;

  const saved: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  const module = await import(`../src/core/env.ts?case=${Math.random()}`);
  module.resetEnvCache();
  return {
    module,
    dir,
    read: () => JSON.parse(readFileSync(join(dir, "pi-plus.json"), "utf8")).env,
    cleanup: () => {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a missing store reads as empty", async () => {
  const { module, cleanup } = await setup();
  try {
    assert.equal(module.env("ARTIFICIAL_ANALYSIS_API_KEY"), undefined);
  } finally {
    cleanup();
  }
});

test("values round-trip through the store", async () => {
  const { module, read, cleanup } = await setup();
  try {
    assert.equal(module.setEnv("AGENT_BOARD_URL", "ws://host:8787/ws"), true);
    assert.equal(module.env("AGENT_BOARD_URL"), "ws://host:8787/ws");
    assert.equal(read().AGENT_BOARD_URL, "ws://host:8787/ws");
  } finally {
    cleanup();
  }
});

test("process.env wins over the stored value", async () => {
  const { module, cleanup } = await setup({ "pi-plus.json": { env: { ARTIFICIAL_ANALYSIS_API_KEY: "from-file" } } });
  try {
    assert.equal(module.env("ARTIFICIAL_ANALYSIS_API_KEY"), "from-file");
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "from-shell";
    assert.equal(module.env("ARTIFICIAL_ANALYSIS_API_KEY"), "from-shell");
    assert.equal(module.isFromProcessEnv("ARTIFICIAL_ANALYSIS_API_KEY"), true);
  } finally {
    cleanup();
  }
});

test("blank values are treated as absent", async () => {
  const { module, cleanup } = await setup({ "pi-plus.json": { env: { AGENT_BOARD_TOKEN: "   " } } });
  try {
    assert.equal(module.env("AGENT_BOARD_TOKEN"), undefined);
    process.env.AGENT_BOARD_TOKEN = "  ";
    assert.equal(module.isFromProcessEnv("AGENT_BOARD_TOKEN"), false, "whitespace is not a value");
  } finally {
    cleanup();
  }
});

test("setEnv with an empty value removes the key", async () => {
  const { module, read, cleanup } = await setup();
  try {
    module.setEnv("AGENT_BOARD_NAME", "you");
    module.setEnv("AGENT_BOARD_NAME", "");
    assert.equal(module.env("AGENT_BOARD_NAME"), undefined);
    assert.equal("AGENT_BOARD_NAME" in read(), false);
  } finally {
    cleanup();
  }
});

test("values are trimmed on write and read", async () => {
  const { module, cleanup } = await setup();
  try {
    module.setEnv("ARTIFICIAL_ANALYSIS_API_KEY", "  aa_padded  ");
    assert.equal(module.env("ARTIFICIAL_ANALYSIS_API_KEY"), "aa_padded");
  } finally {
    cleanup();
  }
});

test("the legacy key file migrates into the store", async () => {
  const { module, read, cleanup } = await setup({
    "model-quality-key.json": { artificialAnalysis: "aa_legacy_key" },
  });
  try {
    assert.equal(module.env("ARTIFICIAL_ANALYSIS_API_KEY"), "aa_legacy_key");
    assert.equal(read().ARTIFICIAL_ANALYSIS_API_KEY, "aa_legacy_key", "written through to the unified file");
  } finally {
    cleanup();
  }
});

test("the legacy board file migrates, including the display name", async () => {
  const { module, cleanup } = await setup({
    "agent-board.json": { url: "ws://old:8787/ws", token: "old-token", adminName: "james" },
  });
  try {
    assert.equal(module.env("AGENT_BOARD_URL"), "ws://old:8787/ws");
    assert.equal(module.env("AGENT_BOARD_TOKEN"), "old-token");
    assert.equal(module.env("AGENT_BOARD_NAME"), "james");
  } finally {
    cleanup();
  }
});

test("migration never overwrites an existing unified value", async () => {
  const { module, cleanup } = await setup({
    "pi-plus.env.json": { ARTIFICIAL_ANALYSIS_API_KEY: "aa_current" },
    "model-quality-key.json": { artificialAnalysis: "aa_legacy" },
  });
  try {
    assert.equal(module.env("ARTIFICIAL_ANALYSIS_API_KEY"), "aa_current");
  } finally {
    cleanup();
  }
});

test("legacy files are preserved, not deleted", async () => {
  const { module, dir, cleanup } = await setup({
    "model-quality-key.json": { artificialAnalysis: "aa_legacy_key" },
  });
  try {
    module.env("ARTIFICIAL_ANALYSIS_API_KEY");
    assert.ok(existsSync(join(dir, "model-quality-key.json")), "downgrading must still work");
  } finally {
    cleanup();
  }
});

test("maskSecret reveals enough to recognise but not to use", async () => {
  const { module, cleanup } = await setup();
  try {
    assert.equal(module.maskSecret("aa_EXAMPLEkeyNOTreal0000000000000000"), "aa_EX…0000");
    assert.equal(module.maskSecret("short"), "•••••");
    assert.doesNotMatch(module.maskSecret("aa_EXAMPLEkeyNOTreal0000000000000000"), /EXAMPLEkeyNOTreal/);
  } finally {
    cleanup();
  }
});
