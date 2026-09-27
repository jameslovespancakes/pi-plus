import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("workflow completion delivery uses native session boundaries", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--experimental-transform-types", "--test", "--test-reporter=tap", "tests/fixtures/workflow-delivery.ts"], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000,
  });
  assert.match(output, /native SDK completion preserves tool batches/);
  assert.match(output, /# fail 0/);
});
