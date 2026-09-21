import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowAgentLimitError,
  WorkflowAgentLimiter,
} from "../src/domains/workflows/runtime/agent-limits.ts";
import { combinedAgentAttemptError } from "../src/domains/workflows/runtime/agent-failure.ts";
import {
  providerErrorFromMessages,
  WorkflowProviderError,
} from "../src/domains/workflows/runtime/agent-retry.ts";
import { WorktreeRegistry } from "../src/domains/workflows/runtime/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("agent reservations release setup-only calls but count live attempts", () => {
  const limiter = new WorkflowAgentLimiter(1);
  const setupOnly = limiter.reserve(undefined);
  setupOnly.release();

  const live = limiter.reserve(undefined);
  live.commit();
  assert.throws(() => limiter.reserve(undefined), WorkflowAgentLimitError);
});

test("failed workflow worktrees keep edits while untouched worktrees are cleaned", async () => {
  const repository = mkdtempSync(join(tmpdir(), "pi-plus-workflow-recovery-"));
  const worktrees = new WorktreeRegistry(repository);

  try {
    git(repository, "init", "--quiet");
    git(repository, "config", "user.name", "workflow-test");
    git(repository, "config", "user.email", "workflow-test@example.invalid");
    writeFileSync(join(repository, "baseline.txt"), "baseline\n");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "baseline");

    const failed = await worktrees.add();
    const untouched = await worktrees.add();
    assert.equal("error" in failed, false);
    assert.equal("error" in untouched, false);
    if ("error" in failed || "error" in untouched) return;

    worktrees.markRecoverable(failed.path);
    writeFileSync(join(failed.path, "unfinished-change.txt"), "recover me\n");
    worktrees.preserveRecoverable();
    await worktrees.removeUnpreserved();

    assert.deepEqual(worktrees.preservedPaths, [failed.path]);
    assert.equal(existsSync(join(failed.path, "unfinished-change.txt")), true);
    assert.equal(existsSync(untouched.path), false);
  } finally {
    await worktrees.removeAll().catch(() => undefined);
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Codex access-verification glitches identify the selected model and are retryable", () => {
  const error = providerErrorFromMessages([{
    role: "assistant",
    stopReason: "error",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    api: "openai-codex-responses",
    errorMessage: '{"detail":"Unable to verify Daybreak Blue access. Please try again."}',
  }]);

  assert.ok(error instanceof WorkflowProviderError);
  assert.equal(error.retryable, true);
  assert.match(error.message, /selected model openai-codex\/gpt-5\.6-sol/);
  assert.match(error.message, /No alternate model was requested/);
  assert.match(error.message, /Daybreak Blue/);
});

test("retry failure reports both the earlier provider error and final agent limit", () => {
  const error = combinedAgentAttemptError(
    "implement",
    [new Error("503 service unavailable during implementation")],
    new WorkflowAgentLimitError(1),
  );

  assert.match(error.message, /Earlier attempt: 503 service unavailable during implementation/);
  assert.match(error.message, /Final failure: Workflow live-agent limit of 1 has been reached/);
  assert.equal(error.errors.length, 2);
});
