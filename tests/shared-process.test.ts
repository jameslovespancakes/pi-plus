import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess } from "../src/core/exec/process.ts";
import { runBoundedProcess } from "../src/core/exec/bounded-process.ts";

const NODE = process.execPath;

test("shared process execution streams binary file input without changing bytes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "input.bin");
  const input = Buffer.from([0, 1, 127, 128, 254, 255]);
  writeFileSync(file, input);
  const result = await runProcess(NODE, ["-e", "const a=[];process.stdin.on('data',b=>a.push(b));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(a).toString('hex')))"], {
    input: { file }, timeoutSeconds: 5,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, input.toString("hex"));
});

test("shared process execution terminates and rejects on unreadable file input", async () => {
  await assert.rejects(runProcess(NODE, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], {
    input: { file: join(tmpdir(), "pi-missing-input", "not-present.bin") }, timeoutSeconds: 5,
  }), /ENOENT/);
});

test("tail policy keeps long jobs running and still counts all output bytes", async () => {
  const size = 2 * 1024 * 1024 + 123;
  const result = await runProcess(NODE, ["-e", `process.stdout.write('x'.repeat(${size})+'END')`], { timeoutSeconds: 10 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 2 * 1024 * 1024);
  assert.ok(result.stdout.endsWith("END"));
  assert.equal(result.totalOutputBytes, size + 3);
});

test("strict capture policy still stops over-limit output instead of silently truncating", async () => {
  const result = await runBoundedProcess({
    file: NODE, args: ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"],
    cwd: process.cwd(), timeoutMs: 5_000, maxBufferBytes: 100,
    abortError: "aborted", timeoutError: "timed out", exitError: () => "failed",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.kind, "max-buffer");
  assert.ok(result.stdout.length <= 100);
});
