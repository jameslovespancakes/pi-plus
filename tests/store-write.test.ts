import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getRoutingMode, loadAccounts, saveAccounts } from "../src/core/anthropic/store.ts";

function fixture() {
  const cfg = join(tmpdir(), `pp-store-${randomUUID()}.json`);
  const storage = {
    version: 1,
    accounts: [{ id: "a1", label: "A", type: "oauth" as const, enabled: true, access: "t", refresh: "r", expires: 1 }],
    routing: { mode: "sequential" as const },
  };
  const cleanup = () => [cfg, cfg.replace(/\.json$/, ".state.json")].forEach((p) => rmSync(p, { force: true }));
  return { cfg, storage, cleanup };
}

test("legacy Claude routing modes migrate to the two public modes", () => {
  assert.equal(getRoutingMode({ accounts: [], routing: { mode: "main-first" as any } }), "sequential");
  assert.equal(getRoutingMode({ accounts: [], routing: { mode: "sticky-balanced" as any } }), "quota-aware");
});

test("a write survives the destination being held open", () => {
  // Windows rejects rename onto a file another handle has open, which is how
  // a virus scanner, the search indexer or a second pi session looks. The
  // symptom was EPERM thrown into a live request.
  const { cfg, storage, cleanup } = fixture();
  saveAccounts(storage, cfg);

  const fd = openSync(cfg, "r");
  try {
    assert.doesNotThrow(() => saveAccounts({ ...storage, routing: { mode: "quota-aware" } }, cfg));
  } finally {
    closeSync(fd);
  }
  cleanup();
});

test("a failed write leaves no temp file behind", () => {
  const { cfg, storage, cleanup } = fixture();
  saveAccounts(storage, cfg);
  const fd = openSync(cfg, "r");
  try { saveAccounts(storage, cfg); } catch { /* may or may not fail */ }
  closeSync(fd);
  assert.equal(existsSync(`${cfg}.${process.pid}.tmp`), false);
  cleanup();
});

test("writes still land when nothing is holding the file", () => {
  const { cfg, storage, cleanup } = fixture();
  saveAccounts(storage, cfg);
  saveAccounts({ ...storage, routing: { mode: "quota-aware" } }, cfg);
  assert.equal(loadAccounts(cfg)?.routing?.mode, "quota-aware");
  cleanup();
});

test("rewriting identical content still produces a valid file", () => {
  const { cfg, storage, cleanup } = fixture();
  saveAccounts(storage, cfg);
  const size = statSync(cfg).size;
  saveAccounts(storage, cfg);
  assert.equal(statSync(cfg).size, size);
  assert.equal(loadAccounts(cfg)?.accounts.length, 1);
  cleanup();
});
