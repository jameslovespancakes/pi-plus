import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerClaudeRemote } from "../src/domains/claude-remote/index.ts";
import { createTokenSource } from "../src/domains/claude-remote/auth.ts";
import { resetConfigCache } from "../src/core/config.ts";
import { env } from "../src/core/env.ts";

function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-claude-test-"));
  const keys = ["PI_PLUS_CONFIG", "PI_AGENT_DIR", "PI_CLAUDE_REMOTE", "PI_CLAUDE_REMOTE_ALLOW_INBOUND", "CLAUDE_TRUSTED_DEVICE_TOKEN"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => { delete process.env[key]; });
  process.env.PI_PLUS_CONFIG = join(dir, "config.json");
  process.env.PI_AGENT_DIR = dir;
  resetConfigCache();
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const bridges: any[] = [];
  const sent: any[] = [];
  const notices: string[] = [];
  const statuses = new Map<string, string>();
  const statusHistory: (string | undefined)[] = [];
  let idle = true;
  let aborts = 0;
  let tokenSources = 0;
  let confirmed = true;
  const ctx: any = {
    cwd: "/project", mode: "tui", hasUI: true, isIdle: () => idle, abort: () => { aborts++; },
    ui: {
      notify: (message: string) => notices.push(message), confirm: async () => confirmed, select: async () => undefined,
      theme: { fg: (color: string, text: string) => `${color}:${text}`, bold: (text: string) => text },
      setStatus: (key: string, text: string | undefined) => {
        statusHistory.push(text);
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
  };
  const pi: any = {
    on: (event: string, fn: Function) => handlers.set(event, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getSessionName: () => "test",
    sendUserMessage: (text: string, options: unknown) => sent.push({ text, options }),
  };
  registerClaudeRemote(pi, {
    tokenSource: () => { tokenSources++; return async () => "fake"; },
    bridge: (options) => {
      const bridge = { options, stopped: false, sent: [] as any[], states: [] as string[],
        start: async () => { options.onConnect(`cse_${bridges.length}`); },
        stop() { this.stopped = true; },
        send(message: any) { this.sent.push(message); },
        reportState(state: string) { this.states.push(state); },
      };
      bridges.push(bridge);
      return bridge;
    },
  });
  t.after(() => {
    handlers.get("session_shutdown")?.({}, ctx);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ctx, handlers, bridges, sent, notices, statuses, statusHistory,
    emit: (event: string, value: any = {}) => handlers.get(event)?.(value, ctx),
    command: (args: string) => commands.get("claude-remote").handler(args, ctx),
    completions: () => commands.get("claude-remote").getArgumentCompletions(""),
    idle: (value: boolean) => { idle = value; },
    confirm: (value: boolean) => { confirmed = value; },
    get aborts() { return aborts; }, get tokenSources() { return tokenSources; },
  };
}

test("default is inert: no bridge, credential resolution, context hooks or tools", async (t) => {
  const h = setup(t);
  h.emit("session_start");
  h.emit("message_end", { message: { role: "user", content: "hi" } });
  h.emit("agent_start");
  for (const removed of ["start", "stop", "status"]) await h.command(removed);
  assert.deepEqual(h.completions().map((item: any) => item.value), ["on", "off"]);
  assert.equal(h.bridges.length, 0);
  assert.equal(h.tokenSources, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.handlers.has("context"), false);
  assert.equal(h.handlers.has("before_agent_start"), false);
});

test("on/off persists, asks consent and avoids duplicate connections", async (t) => {
  const h = setup(t);
  h.confirm(false);
  await h.command("on");
  assert.equal(h.bridges.length, 0);
  h.confirm(true);
  await h.command("on");
  await h.command("on");
  assert.equal(h.bridges.length, 1);
  assert.equal(env("PI_CLAUDE_REMOTE"), "1");
  await h.command("off");
  assert.equal(env("PI_CLAUDE_REMOTE"), "0");
  assert.equal(h.bridges[0].stopped, true);
  h.bridges[0].options.onText("stale");
  h.bridges[0].options.onInterrupt();
  assert.deepEqual(h.sent, []);
  assert.equal(h.aborts, 0);
});

test("inbound queues busy follow-ups; count-based echo suppression handles repeated prompts", async (t) => {
  const h = setup(t);
  await h.command("on");
  const b = h.bridges[0];
  h.idle(false);
  b.options.onText("same");
  b.options.onText("same");
  assert.deepEqual(h.sent.map((item) => item.options), [{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
  h.emit("message_end", { message: { role: "user", content: "same" } });
  h.emit("message_end", { message: { role: "user", content: "same" } });
  assert.equal(b.sent.length, 0);
  h.emit("message_end", { message: { role: "user", content: "same" } });
  assert.equal(b.sent.length, 1);
  h.emit("agent_start");
  h.emit("agent_end");
  assert.deepEqual(b.states, ["idle", "running", "idle"]);
  b.options.onInterrupt();
  assert.equal(h.aborts, 1);
});

test("auto-start only in TUI; off persists and shutdown makes old callbacks inert", async (t) => {
  const h = setup(t);
  await h.command("on");
  assert.equal(env("PI_CLAUDE_REMOTE"), "1");
  h.ctx.mode = "rpc";
  h.emit("session_start");
  assert.equal(h.bridges.length, 1);
  h.ctx.mode = "tui";
  h.emit("session_start");
  assert.equal(h.bridges.length, 2);
  h.emit("session_shutdown");
  h.bridges[1].options.onText("stale");
  assert.equal(h.sent.length, 0);
  await h.command("off");
  assert.equal(env("PI_CLAUDE_REMOTE"), "0");
});

test("tree switch creates a new bridge and old failures cannot stop it", async (t) => {
  const h = setup(t);
  await h.command("on");
  h.emit("session_tree");
  assert.equal(h.bridges.length, 2);
  assert.equal(h.bridges[0].stopped, true);
  h.bridges[0].options.onError("late failure");
  assert.equal(h.bridges[1].stopped, false);
  h.bridges[1].options.onText("new branch");
  assert.equal(h.sent[0].text, "new branch");
});

test("read-only env controls input and stop without replacing local agent behavior", async (t) => {
  const h = setup(t);
  process.env.PI_CLAUDE_REMOTE_ALLOW_INBOUND = "0";
  await h.command("on");
  h.bridges[0].options.onText("ignored");
  h.bridges[0].options.onInterrupt();
  assert.deepEqual(h.sent, []);
  assert.equal(h.aborts, 0);
  h.emit("message_end", { message: { role: "user", content: "local" } });
  assert.equal(h.bridges[0].sent.length, 1);
});

test("menu is an in-place provider-style on/off toggle", async (t) => {
  const h = setup(t);
  h.ctx.ui.custom = async (factory: any) => {
    let closed = false;
    const component = factory({}, h.ctx.ui.theme, {}, () => { closed = true; });
    assert.match(component.render(100).join("\n"), /●.*Remote Control.*Off/);
    assert.doesNotMatch(component.render(100).join("\n"), /Shares sessions|Auto-starts/);
    component.handleInput("\r");
    assert.match(component.render(100).join("\n"), /●.*Remote Control.*On/);
    assert.equal(h.bridges.length, 1);
    assert.equal(env("PI_CLAUDE_REMOTE"), "1");
    assert.equal(closed, false);
    component.handleInput(" ");
    assert.match(component.render(100).join("\n"), /●.*Remote Control.*Off/);
    assert.equal(h.bridges[0].stopped, true);
    assert.equal(env("PI_CLAUDE_REMOTE"), "0");
    component.handleInput("\u001b");
    assert.equal(closed, true);
  };
  await h.command("");
});

test("footer shows red offline/connecting, green connected, and clears on shutdown", async (t) => {
  const h = setup(t);
  h.emit("session_start");
  assert.equal(h.statuses.get("claude-remote"), "error:● Remote Control Offline");
  await h.command("on");
  assert.ok(h.statusHistory.includes("error:● Remote Control Connecting"));
  assert.equal(h.statuses.get("claude-remote"), "success:● Remote Control Active");
  h.bridges[0].options.onConnectionChange(false);
  assert.equal(h.statuses.get("claude-remote"), "error:● Remote Control Connecting");
  h.bridges[0].options.onConnectionChange(true);
  assert.equal(h.statuses.get("claude-remote"), "success:● Remote Control Active");
  h.bridges[0].options.onError("Disconnected");
  assert.equal(h.statuses.get("claude-remote"), "error:● Remote Control Offline");
  await h.command("on");
  await h.command("off");
  assert.equal(h.statuses.get("claude-remote"), "error:● Remote Control Offline");
  process.env.PI_CLAUDE_REMOTE_ALLOW_INBOUND = "0";
  await h.command("on");
  assert.equal(h.statuses.get("claude-remote"), "success:● Remote Control Read-only");
  h.emit("session_shutdown");
  assert.equal(h.statuses.has("claude-remote"), false);
  h.bridges.at(-1).options.onConnect("stale");
  assert.equal(h.statuses.has("claude-remote"), false);
});

test("footer status is not installed without a UI", (t) => {
  const h = setup(t);
  h.ctx.hasUI = false;
  h.ctx.mode = "json";
  h.emit("session_start");
  assert.equal(h.statusHistory.length, 0);
});

test("native auth runtime is lazy, reused, and resolves fresh OAuth each time", async () => {
  let creates = 0;
  let resolves = 0;
  const signal = new AbortController().signal;
  const source = createTokenSource(async () => {
    creates++;
    return {
      listCredentials: async () => [{ providerId: "anthropic", type: "oauth" as const }],
      getAuth: async (provider: any, options: any) => {
        assert.equal(provider, "anthropic");
        assert.equal(options.signal, signal);
        return { auth: { apiKey: `access-${++resolves}` }, source: "OAuth" };
      },
    };
  });
  assert.equal(creates, 0);
  assert.equal(await source(signal), "access-1");
  assert.equal(await source(signal), "access-2");
  assert.equal(creates, 1);
});

test("auth rejects API keys/missing credentials and respects cancellation", async () => {
  for (const credentials of [[], [{ providerId: "anthropic", type: "api_key" as const }]]) {
    const source = createTokenSource(async () => ({
      listCredentials: async () => credentials,
      getAuth: async () => { assert.fail("Must not resolve non-OAuth auth"); },
    }));
    await assert.rejects(source(new AbortController().signal), /OAuth login required/);
  }
  const source = createTokenSource(async () => { assert.fail("Aborted before runtime construction"); });
  await assert.rejects(source(AbortSignal.abort()));
});
