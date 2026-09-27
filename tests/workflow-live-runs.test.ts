import test from "node:test";
import assert from "node:assert/strict";
import { bindLiveRun, disposeLiveRuns, liveRuns } from "../src/domains/workflows/runs/live-runs.ts";

function fixture() {
  let id = "first";
  const pi = {} as any;
  const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => id } } as any;
  const source = (runId: string) => ({ snapshot: () => ({ runId }) }) as any;
  return { pi, ctx, source, changeSession: (next: string) => { id = next; } };
}

test("live run bindings have one query source and unbind cleanly", () => {
  const h = fixture();
  const bind = bindLiveRun(h.pi, h.ctx, "review", "HEAD");
  const source = h.source("one");
  bind(source);
  assert.equal(liveRuns(h.pi, h.ctx).get("one")?.source, source);
  assert.equal(liveRuns(h.pi, h.ctx).get("one")?.name, "review");
  bind(h.source("replacement"));
  assert.deepEqual([...liveRuns(h.pi, h.ctx).keys()], ["replacement"]);
  bind(undefined);
  assert.equal(liveRuns(h.pi, h.ctx).size, 0);
});

test("late source callbacks cannot resurrect state after session replacement", () => {
  const h = fixture();
  const bind = bindLiveRun(h.pi, h.ctx, "review", "");
  bind(h.source("one"));
  disposeLiveRuns(h.pi, h.ctx);
  h.changeSession("second");
  bind(h.source("late"));
  assert.equal(liveRuns(h.pi, h.ctx).size, 0);
  h.changeSession("first");
  assert.equal(liveRuns(h.pi, h.ctx).size, 0);
});

test("extension reload instances cannot share live run bindings", () => {
  const h = fixture();
  bindLiveRun(h.pi, h.ctx, "review", "")(h.source("one"));
  assert.equal(liveRuns({} as any, h.ctx).size, 0);
  assert.equal(liveRuns(h.pi, h.ctx).size, 1);
});
