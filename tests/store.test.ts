import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDir, agentPath, readJson, writeJson } from "../src/core/store.ts";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-store-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("agentDir honours PI_AGENT_DIR", () => {
  const previous = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = join("C:", "custom", "agent");
  try {
    assert.equal(agentDir(), join("C:", "custom", "agent"));
    assert.equal(agentPath("a.json"), join("C:", "custom", "agent", "a.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previous;
  }
});

test("readJson returns the fallback for missing and malformed files", () => {
  withTempDir((dir) => {
    assert.deepEqual(readJson(join(dir, "missing.json"), { ok: true }), { ok: true });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json", "utf8");
    assert.deepEqual(readJson(broken, { ok: true }), { ok: true });
  });
});

test("writeJson round-trips through readJson", () => {
  withTempDir((dir) => {
    const path = join(dir, "value.json");
    assert.equal(writeJson(path, { count: 2, nested: { a: [1, 2] } }), true);
    assert.deepEqual(readJson(path, undefined), { count: 2, nested: { a: [1, 2] } });
  });
});

test("writeJson pretty-prints only when asked", () => {
  withTempDir((dir) => {
    const compact = join(dir, "compact.json");
    const pretty = join(dir, "pretty.json");
    writeJson(compact, { a: 1 });
    writeJson(pretty, { a: 1 }, true);
    assert.equal(readFileSync(compact, "utf8").includes("\n"), false);
    assert.ok(readFileSync(pretty, "utf8").includes("\n"));
  });
});

test("writeJson leaves no temp file behind", () => {
  withTempDir((dir) => {
    const path = join(dir, "clean.json");
    writeJson(path, { a: 1 });
    assert.deepEqual(readJson(path, undefined), { a: 1 });
    assert.deepEqual(readJson(`${path}.${process.pid}.tmp`, "absent"), "absent");
  });
});

test("writeJson reports failure instead of throwing", () => {
  withTempDir((dir) => {
    // A directory path can never be written as a file.
    assert.equal(writeJson(dir, { a: 1 }), false);
  });
});

test("writeJson survives values that JSON.stringify drops", () => {
  withTempDir((dir) => {
    const path = join(dir, "sparse.json");
    assert.equal(writeJson(path, { keep: 1, drop: undefined, fn: () => 1 }), true);
    assert.deepEqual(readJson(path, undefined), { keep: 1 });
  });
});
