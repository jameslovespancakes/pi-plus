import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomicText, writeAtomicTextSync } from "../src/core/storage/atomic.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("atomic writers replace complete files and preserve explicit secret permissions", async (t) => {
  const dir = fixture(t), file = join(dir, "state.json");
  writeAtomicTextSync(file, '{"version":1}', { mode: 0o600 });
  await writeAtomicText(file, '{"version":2}', { mode: 0o600 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 2 });
  assert.deepEqual(readdirSync(dir), ["state.json"]);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("strict atomic writes surface errors and clean temporary files", async (t) => {
  const dir = fixture(t), target = join(dir, "target");
  mkdirSync(target);
  assert.throws(() => writeAtomicTextSync(target, "cannot replace a directory"));
  await assert.rejects(writeAtomicText(target, "cannot replace a directory"));
  assert.ok(statSync(target).isDirectory());
  assert.deepEqual(readdirSync(dir), ["target"]);
});

test("only explicitly best-effort callers may drop a failed atomic replacement", (t) => {
  const dir = fixture(t), target = join(dir, "target");
  mkdirSync(target);
  assert.equal(writeAtomicTextSync(target, "ignored", { dropAfterRetries: true }), false);
  assert.ok(statSync(target).isDirectory());
  assert.deepEqual(readdirSync(dir), ["target"]);
  assert.throws(() => writeAtomicTextSync(join(target, "missing", "\0"), "bad input", { dropAfterRetries: true }));
});

test("concurrent writes never share a temporary filename or expose partial content", async (t) => {
  const dir = fixture(t), file = join(dir, "state.json");
  const values = Array.from({ length: 12 }, (_, writer) => JSON.stringify({ writer, text: "x".repeat(10_000) }));
  const results = await Promise.allSettled(values.map((value) => writeAtomicText(file, value)));
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.ok(values.includes(readFileSync(file, "utf8")));
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});
