import test from "node:test";
import assert from "node:assert/strict";
import { applyCodexQuotaHeaders, parseCodexQuotaHeaders } from "../src/core/codex/quota.ts";
import { claimsOf, loadCodexAccounts, saveCodexAccounts } from "../src/core/codex/store.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function withCodexStore(run: (path: string) => void): void {
  const path = join(tmpdir(), `pi-plus-codex-quota-${randomUUID()}.json`);
  process.env.PI_PLUS_CODEX_ACCOUNTS_FILE = path;
  try {
    run(path);
  } finally {
    rmSync(path, { force: true });
    delete process.env.PI_PLUS_CODEX_ACCOUNTS_FILE;
  }
}

/** Real headers captured from a live Codex response. */
const LIVE = {
  "x-codex-plan-type": "pro",
  "x-codex-active-limit": "premium",
  "x-codex-primary-used-percent": "2",
  "x-codex-primary-window-minutes": "10080",
  "x-codex-primary-reset-at": "1790425696",
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
};

test("codex percentages are NOT rescaled", () => {
  // Anthropic sends 0-1 fractions and needs x100; Codex already sends 0-100.
  // Applying the Anthropic scaling here would report 200% used.
  const q = parseCodexQuotaHeaders(LIVE)!;
  assert.equal(q.seven_day?.usedPercent, 2);
  assert.equal(q.seven_day?.remainingPercent, 98);
});

test("the 10080-minute window maps to seven_day", () => {
  const q = parseCodexQuotaHeaders(LIVE)!;
  assert.equal(q.seven_day?.usedPercent, 2, "primary is the weekly window");
});

test("a zero-length window is dropped rather than read as 0% used", () => {
  // secondary-window-minutes = 0 means "not applicable". Treating it as a real
  // window at 0% used would make the account look infinitely available.
  assert.equal(parseCodexQuotaHeaders(LIVE)!.five_hour, undefined);
});

test("windows are mapped by duration, not by name", () => {
  // If Codex ever reports a short primary and long secondary, the weekly
  // window must still land in seven_day.
  const swapped = {
    "x-codex-primary-used-percent": "10",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "40",
    "x-codex-secondary-window-minutes": "10080",
  };
  const q = parseCodexQuotaHeaders(swapped)!;
  assert.equal(q.five_hour?.usedPercent, 10, "5h window in the short slot");
  assert.equal(q.seven_day?.usedPercent, 40, "weekly window in the long slot");
});

test("reset seconds become an ISO timestamp", () => {
  const q = parseCodexQuotaHeaders(LIVE)!;
  assert.equal(q.seven_day?.resetsAt, new Date(1790425696 * 1000).toISOString());
});

test("plan is carried through for display", () => {
  assert.equal((parseCodexQuotaHeaders(LIVE) as any).plan, "pro");
});

test("absent codex headers yield undefined", () => {
  assert.equal(parseCodexQuotaHeaders(undefined), undefined);
  assert.equal(parseCodexQuotaHeaders({}), undefined);
  assert.equal(parseCodexQuotaHeaders({ "content-type": "application/json" }), undefined);
});

test("header casing does not matter", () => {
  const q = parseCodexQuotaHeaders({
    "X-Codex-Primary-Used-Percent": "55",
    "X-Codex-Primary-Window-Minutes": "10080",
  })!;
  assert.equal(q.seven_day?.usedPercent, 55);
});

test("claimsOf reads plan and account id from a token", () => {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "pro" },
  })).toString("base64url");
  const claims = claimsOf(`header.${payload}.sig`);
  assert.equal(claims.accountId, "acct-123");
  assert.equal(claims.plan, "pro");
});

test("claimsOf tolerates a malformed token", () => {
  assert.deepEqual(claimsOf("not-a-jwt"), {});
  assert.deepEqual(claimsOf(undefined), {});
});

test("rename changes only the label, never the credentials", () => {
  // A rename that dropped tokens would silently force a re-login, so this
  // pins the fields that must survive.
  const path = join(tmpdir(), `codex-rename-${randomUUID()}.json`);
  const account = {
    id: "a1", label: "Old", enabled: true,
    access: "tok", refresh: "ref", expires: 123, accountId: "acct-1", plan: "pro",
  };
  saveCodexAccounts({ accounts: [account] }, path);

  const storage = loadCodexAccounts(path);
  storage.accounts[0]!.label = "New";
  saveCodexAccounts(storage, path);

  const after = loadCodexAccounts(path).accounts[0]!;
  assert.equal(after.label, "New");
  assert.equal(after.access, "tok");
  assert.equal(after.refresh, "ref");
  assert.equal(after.expires, 123);
  assert.equal(after.accountId, "acct-1");
  rmSync(path, { force: true });
});

test("an unchanged reading never rewrites the credential file", () => {
  // applyCodexQuotaHeaders runs from onResponse on EVERY reply. Rewriting live
  // OAuth credentials that often is what made concurrent readers observe a
  // half-written file, so an identical reading must be a no-op.
  withCodexStore((path) => {
    assert.equal(applyCodexQuotaHeaders("main", LIVE), true, "first reading is stored");
    const before = readFileSync(path, "utf8");

    assert.equal(applyCodexQuotaHeaders("main", LIVE), false, "identical reading is skipped");
    assert.equal(readFileSync(path, "utf8"), before, "file must be untouched");

    const moved = { ...LIVE, "x-codex-primary-used-percent": "9" };
    assert.equal(applyCodexQuotaHeaders("main", moved), true, "a real change still writes");
    assert.notEqual(readFileSync(path, "utf8"), before);
  });
});

test("a failed quota write is swallowed rather than killing the stream", () => {
  // This runs inside the awaited onResponse; throwing would reject an
  // in-flight stream. An unwritable path must simply report "not stored".
  const blocker = join(tmpdir(), `pi-plus-codex-blocker-${randomUUID()}`);
  writeFileSync(blocker, "not a directory");
  process.env.PI_PLUS_CODEX_ACCOUNTS_FILE = join(blocker, "accounts.json");
  try {
    assert.equal(applyCodexQuotaHeaders("main", LIVE), false);
  } finally {
    rmSync(blocker, { force: true });
    delete process.env.PI_PLUS_CODEX_ACCOUNTS_FILE;
  }
});

test("credential writes are atomic and leave no temp file behind", () => {
  withCodexStore((path) => {
    saveCodexAccounts({ accounts: [{ id: "a1", label: "Work", access: "tok" }] }, path);

    assert.ok(statSync(path).isFile());
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).accounts.length, 1);

    const strays = readdirSync(dirname(path)).filter((name) =>
      name.startsWith(`${path.split(/[\\/]/).pop()}.`) && name.endsWith(".tmp"));
    assert.deepEqual(strays, [], "the temp file must be renamed, not left behind");
  });
});

test("a duplicate ChatGPT account is detectable before it is stored", () => {
  // Two entries sharing one accountId would look like capacity that is not
  // there, so the adapter refuses them; this pins the field it matches on.
  const path = join(tmpdir(), `codex-dup-${randomUUID()}.json`);
  saveCodexAccounts({ accounts: [{ id: "a1", label: "Work", accountId: "acct-1" }] }, path);
  const existing = loadCodexAccounts(path).accounts.find((a) => a.accountId === "acct-1");
  assert.ok(existing, "same ChatGPT account must be found by accountId");
  rmSync(path, { force: true });
});
