import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBoardDeliveries, formatBoardSnapshot } from "../src/domains/agents/format.ts";

test("board snapshots stay compact and omit volatile prompt and tool arguments", () => {
  const agent = {
    sessionId: "agent-session",
    alias: "reviewer",
    host: "worker",
    repo: "https://example.test/repo",
    branch: "main",
    commit: "2222222222222222",
    state: "tool" as const,
    lastTool: "read: {\"path\":\"a/very/volatile/path.ts\"}",
    lastPrompt: "A volatile prompt that should not enter the automatic snapshot",
    reports: [],
  };
  const text = formatBoardSnapshot([agent], {
    repo: "https://example.test/repo",
    branch: "main",
    commit: "1111111111111111",
  }, {
    repoThread: "repo-thread",
    coordinator: "lead",
  });

  assert.match(text, /^\[board main@111111111111 1 peer room=repo-thread reports-to=lead\]/);
  assert.match(text, /reviewer@worker tool:read main@222222222222 !commit/);
  assert.doesNotMatch(text, /volatile prompt|volatile\/path/);
});

test("board deliveries batch compact routing envelopes", () => {
  const text = formatBoardDeliveries([
    {
      message: {
        senderId: "agent-1",
        senderAlias: "reviewer",
        text: "first update",
        priority: "normal",
      },
      thread: { id: "thread-1", title: "Review" },
    },
    {
      message: {
        senderId: "agent-2",
        text: "urgent update",
        priority: "urgent",
      },
      thread: { id: "thread-2" },
    },
  ]);

  assert.match(text, /^\[board urgent x2\]/);
  assert.match(text, /from=reviewer thread=thread-1 \(Review\)\nfirst update/);
  assert.match(text, /! from=agent-2 thread=thread-2\nurgent update/);
  assert.doesNotMatch(text, /Evaluate this|Commit context/);
});

test("agent board does not append transient snapshots at provider-request time", () => {
  const source = readFileSync(join(process.cwd(), "src", "domains", "agents", "index.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.on\("context"/);
  assert.match(source, /customType: "agent-board-snapshot"/);
  assert.match(source, /pi\.on\("before_agent_start"/);
});
