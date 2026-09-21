import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatBoardDeliveries } from "../src/domains/agents/format.ts";

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

test("agent board never injects automatic snapshots into model context", () => {
  const source = readFileSync(join(process.cwd(), "src", "domains", "agents", "index.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.on\("context"/);
  assert.doesNotMatch(source, /agent-board-snapshot|formatBoardSnapshot/);
  assert.match(source, /pi\.on\("before_agent_start"/);
});
