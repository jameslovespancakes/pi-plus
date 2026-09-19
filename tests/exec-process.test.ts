import test from "node:test";
import assert from "node:assert/strict";
import { appendTail, rootAssignment, runProcess, shQuote } from "../src/core/exec/process.ts";

const NODE = process.execPath;

/** Runs inline JS through the current node binary so the tests stay cross-platform. */
function node(script: string, options = {}) {
  return runProcess(NODE, ["-e", script], options);
}

test("runProcess captures stdout, stderr and the exit code", async () => {
  const result = await node("process.stdout.write('out');process.stderr.write('err');process.exit(3)");
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.totalOutputBytes, 6);
});

test("runProcess enforces its timeout", async () => {
  const result = await node("setTimeout(() => {}, 60000)", { timeoutSeconds: 1 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("runProcess honours an abort signal", async () => {
  const controller = new AbortController();
  const pending = node("setTimeout(() => {}, 60000)", { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  assert.equal(result.aborted, true);
});

test("runProcess returns immediately when the signal is already aborted", async () => {
  const result = await node("setTimeout(() => {}, 60000)", { signal: AbortSignal.abort() });
  assert.equal(result.aborted, true);
});

test("runProcess streams chunks to onData", async () => {
  const chunks: string[] = [];
  await node("process.stdout.write('a');process.stderr.write('b')", { onData: (c: string) => chunks.push(c) });
  assert.deepEqual(chunks.sort(), ["a", "b"]);
});

test("runProcess writes string input to stdin", async () => {
  const result = await node(
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))",
    { input: "hello" },
  );
  assert.equal(result.stdout, "HELLO");
});

test("runProcess rejects when the binary does not exist", async () => {
  await assert.rejects(() => runProcess("definitely-not-a-real-binary-xyz", []));
});

test("appendTail keeps only the trailing window", () => {
  assert.equal(appendTail("ab", "cd"), "abcd");
  const huge = "x".repeat(3 * 1024 * 1024);
  const capped = appendTail("", huge);
  assert.equal(capped.length, 2 * 1024 * 1024, "capped at the 2MB tail");
  const tailMarker = appendTail(huge, "END");
  assert.ok(tailMarker.endsWith("END"), "the newest output always survives");
});

test("shQuote neutralises embedded single quotes", () => {
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("it's"), `'it'"'"'s'`);
  assert.equal(shQuote("a b; rm -rf /"), "'a b; rm -rf /'");
});

test("shQuote output is inert when evaluated by a shell", async (t) => {
  if (process.platform === "win32") return t.skip("no POSIX shell guaranteed on Windows");
  const hostile = "'; echo pwned; '";
  const result = await runProcess("sh", ["-c", `printf %s ${shQuote(hostile)}`]);
  assert.equal(result.stdout, hostile, "the payload is data, never executed");
});

test("rootAssignment expands a leading tilde through $HOME", () => {
  assert.equal(rootAssignment("~/remote_tests"), `ROOT="$HOME"/'remote_tests'`);
  assert.equal(rootAssignment("/var/tmp"), "ROOT='/var/tmp'");
});
