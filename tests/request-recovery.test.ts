import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { streamWithRecovery, recoveryScheduler, REQUEST_RETRY_DELAYS_MS } from "../src/providers/shared/accounts/request-recovery.ts";
import { providerErrorFromMessages } from "../src/domains/workflows/agents/provider-error.ts";
import { WorkflowProviderUsageLimitError } from "../src/domains/workflows/runs/provider-usage-limit.ts";
import { message, model, response } from "./fixtures/provider-stream.ts";

const next = (excluded: ReadonlySet<string>) => ["first", "second"].map((id) => ({ id })).find((account) => !excluded.has(account.id));

test("account failure switches credentials inside the request, without a delay or leaked failed start", async () => {
  const calls: string[] = [];
  const stream = streamWithRecovery({ model, next,
    stream: (account) => { calls.push(account.id); return response(message(account.id === "first" ? "429 rate limit" : undefined)); },
    scheduler: { sleep: async () => { assert.fail("healthy fallback needs no wait"); } },
  });
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(events, ["start", "done"]);
  assert.equal((await stream.result()).stopReason, "stop");
});

test("all-account failures get exactly three additional rounds after 10s, 25s, and 60s", async () => {
  const calls: string[] = [], waits: number[] = [];
  const stream = streamWithRecovery({ model, next,
    stream: (account) => { calls.push(account.id); return response(message("503 service unavailable")); },
    scheduler: { sleep: async (delay) => { waits.push(delay); } },
  });
  const result = await stream.result();
  assert.deepEqual(waits, [...REQUEST_RETRY_DELAYS_MS]);
  assert.deepEqual(calls, ["first", "second", "first", "second", "first", "second", "first", "second"]);
  assert.equal(result.stopReason, "error");
  assert.equal(isRetryableAssistantError(result), false, "pi must not start a second retry budget");
  assert.match(result.diagnostics!.at(-1)!.error!.message, /503/);
  assert.equal(result.diagnostics!.at(-1)!.details!.attempts, 8);
});

test("pool exhaustion reaches workflow pause classification only after recovery is spent", async () => {
  const waits: number[] = [];
  const result = await streamWithRecovery({ model, next,
    stream: () => response(message("429 account usage limit reached; resets in 1h")),
    scheduler: { sleep: async (delay) => { waits.push(delay); } },
  }).result();
  assert.equal(waits.length, 3);
  assert.ok(providerErrorFromMessages([result], { pauseOnUsageLimit: true }) instanceof WorkflowProviderUsageLimitError);
  assert.equal(isRetryableAssistantError(result), false);
  assert.match(result.errorMessage!, /Resets at/);
});

test("nested workflow/provider recovery does not multiply attempts or waiting", async () => {
  const waits: number[] = [];
  let calls = 0;
  const scheduler = { sleep: async (delay: number) => { waits.push(delay); } };
  const result = await streamWithRecovery({ model, next, scheduler,
    stream: () => streamWithRecovery({ model, next, scheduler,
      stream: () => { calls++; return response(message("429 rate limit")); },
    }),
  }).result();
  assert.equal(calls, 8);
  assert.equal(waits.length, 3);
  assert.equal(result.stopReason, "error");
});

test("partial output is not silently replayed on another account", async () => {
  let calls = 0;
  const failed = message("429 rate limit", { content: [{ type: "text", text: "partial" }] });
  const stream = streamWithRecovery({ model, next,
    stream: () => { calls++; return response(failed, [{ type: "text_delta", contentIndex: 0, delta: "partial", partial: failed }]); },
    scheduler: { sleep: async () => { assert.fail("partial output cannot be replayed"); } },
  });
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "text_delta", "error"]);
  assert.equal(calls, 1);
  const result = await stream.result();
  assert.match(result.errorMessage!, /Output had already begun/);
  assert.equal(providerErrorFromMessages([result], { pauseOnUsageLimit: true }) instanceof WorkflowProviderUsageLimitError, false,
    "durable auto-resume must not restart a partially exposed attempt");
});

test("permanent errors do not rotate or retry", async () => {
  let calls = 0;
  const result = await streamWithRecovery({ model, next,
    stream: () => { calls++; return response(message("No ZDR endpoint is available for this model.")); },
    scheduler: { sleep: async () => { assert.fail("permanent error"); } },
  }).result();
  assert.equal(calls, 1);
  assert.equal(result.errorMessage, "No ZDR endpoint is available for this model.");
});

test("cancellation interrupts backoff and does not consume the next account round", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await streamWithRecovery({ model, next, signal: controller.signal,
    stream: () => { calls++; return response(message("503 unavailable")); },
    scheduler: { sleep: async (delay, signal) => {
      const pending = recoveryScheduler.sleep(delay, signal);
      controller.abort();
      await pending;
    } },
  }).result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(calls, 2);
});

test("empty eligible pools recheck on schedule without bypassing known cooldowns", async () => {
  const waits: number[] = [];
  const result = await streamWithRecovery({ model, next: () => undefined,
    stream: () => { assert.fail("no blocked account may be sent a request"); },
    scheduler: { sleep: async (delay) => { waits.push(delay); } },
  }).result();
  assert.deepEqual(waits, [10000, 25000, 60000]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /Account usage limit/);
});

test("native agent tool work runs once even when the following request needs recovery", async () => {
  let toolRuns = 0, providerCalls = 0;
  const waits: number[] = [];
  const agent = new Agent({
    initialState: { model, thinkingLevel: "off", tools: [{
      name: "change", label: "Change", description: "One side effect", parameters: Type.Object({}),
      execute: async () => { toolRuns++; return { content: [{ type: "text", text: "changed" }], details: {} }; },
    }] },
    streamFn: (selected, context, options) => streamWithRecovery({ model: selected, next, signal: options?.signal,
      scheduler: { sleep: async (delay) => { waits.push(delay); } },
      stream: () => {
        providerCalls++;
        if (providerCalls === 1) return response(message(undefined, { stopReason: "toolUse", content: [
          { type: "toolCall", id: "call_test", name: "change", arguments: {} },
        ] }));
        assert.ok(context.messages.some((entry) => entry.role === "toolResult"));
        return response(message(providerCalls <= 3 ? "503 service unavailable" : undefined));
      },
    }),
  });
  await agent.prompt("Make one change.");
  assert.equal(toolRuns, 1);
  assert.equal(providerCalls, 4);
  assert.deepEqual(waits, [10000]);
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});

test("cancellation settles even while a provider stream ignores its signal", async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const events = createAssistantMessageEventStream();
  const result = streamWithRecovery({ model, next, signal: controller.signal,
    stream: () => { ready(); return events; },
  }).result();
  await started;
  controller.abort();
  assert.equal((await result).stopReason, "aborted");
  events.end();
});

test("an exception after output preserves the exposed partial content and never retries", async () => {
  const partial = message(undefined, { content: [{ type: "text", text: "already shown" }] });
  const result = await streamWithRecovery({ model, next,
    stream: () => ({ async *[Symbol.asyncIterator]() {
      yield { type: "start", partial };
      yield { type: "text_delta", delta: "already shown", contentIndex: 0, partial };
      throw new Error("503 disconnected");
    } }) as any,
    scheduler: { sleep: async () => { assert.fail("partial output cannot be replayed"); } },
  }).result();
  assert.deepEqual(result.content, partial.content);
  assert.match(result.errorMessage!, /Output had already begun/);
});
