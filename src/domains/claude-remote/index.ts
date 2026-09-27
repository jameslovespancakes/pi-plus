import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ClaudeRemoteBridge, type BridgeOptions } from "../../providers/anthropic/remote-control/bridge.ts";
import { mirrorMessage } from "../../providers/anthropic/remote-control/protocol.ts";
import { env } from "../../core/env.ts";
import { createTokenSource } from "../../providers/anthropic/remote-control/auth.ts";
import { remoteControlPicker } from "./picker.ts";

interface Bridge {
  start(): Promise<void>;
  stop(): void;
  send: ClaudeRemoteBridge["send"];
  reportState: ClaudeRemoteBridge["reportState"];
}

/** Dependency seams allow lifecycle tests without network access or real credentials. */
export interface RemoteDependencies {
  bridge(options: BridgeOptions): Bridge;
  tokenSource(): BridgeOptions["getAccessToken"];
}

const defaults: RemoteDependencies = {
  bridge: (options) => new ClaudeRemoteBridge(options),
  tokenSource: () => createTokenSource(),
};

export function registerClaudeRemote(pi: ExtensionAPI, deps: RemoteDependencies = defaults): void {
  let active: Bridge | undefined;
  let status = "off";
  let enabled = false;
  let current: ExtensionContext | undefined;
  let generation = 0;
  let sessionEpoch = 0;
  // Counts rather than a TTL: follow-ups can wait longer than 30 seconds.
  const echoes: string[] = [];

  function notify(ctx: ExtensionContext, message: string, warning = false): void {
    ctx.ui.notify(message, warning ? "warning" : "info");
  }

  function setConnectionStatus(value: string): void {
    status = value;
    if (!current?.hasUI) return;
    const connected = value.startsWith("connected");
    const label = connected ? (value.includes("read-only") ? "Read-only" : "Active")
      : value === "connecting" ? "Connecting" : "Offline";
    current.ui.setStatus("claude-remote",
      current.ui.theme.fg(connected ? "success" : "error", `● Remote Control ${label}`));
  }

  function stop(): void {
    enabled = false;
    ++generation;
    active?.stop();
    active = undefined;
    echoes.length = 0;
    setConnectionStatus("off");
  }

  function endSession(): void {
    ++sessionEpoch;
    stop();
  }

  function start(ctx: ExtensionContext): void {
    if (active) {
      notify(ctx, `Claude Remote: ${status}. Open https://claude.ai/code`);
      return;
    }
    current = ctx;
    enabled = true;
    const gen = ++generation;
    const title = `pi: ${pi.getSessionName() || basename(ctx.cwd) || "session"}`.slice(0, 100);
    setConnectionStatus("connecting");
    try {
      const allowInbound = !/^(0|false|off|no)$/i.test(env("PI_CLAUDE_REMOTE_ALLOW_INBOUND") ?? "1");
      const bridge = deps.bridge({
        title, allowInbound,
        trustedDeviceToken: env("CLAUDE_TRUSTED_DEVICE_TOKEN"),
        getAccessToken: deps.tokenSource(),
        onText(text) {
          if (generation !== gen || !current || !allowInbound) return;
          if (echoes.length >= 256) throw new Error("Too many remote follow-ups");
          echoes.push(text);
          try {
            pi.sendUserMessage(text, current.isIdle() ? undefined : { deliverAs: "followUp" });
          } catch (error) {
            echoes.splice(echoes.lastIndexOf(text), 1);
            throw error;
          }
        },
        onInterrupt() {
          if (generation === gen && allowInbound) current?.abort();
        },
        onConnect(id) {
          if (generation !== gen) return;
          setConnectionStatus(allowInbound ? "connected" : "connected (read-only)");
          notify(ctx, `Claude Remote: ${title} is live at https://claude.ai/code (${id}).`);
        },
        onConnectionChange(connected) {
          if (generation !== gen) return;
          setConnectionStatus(connected ? (allowInbound ? "connected" : "connected (read-only)") : "connecting");
        },
        onError(message) {
          if (generation !== gen) return;
          stop();
          setConnectionStatus("disconnected");
          notify(ctx, `${message}. Pi continues locally.`, true);
        },
      });
      active = bridge;
      bridge.reportState(ctx.isIdle() ? "idle" : "running");
      void bridge.start().catch(() => {
        if (generation !== gen) return;
        stop();
        setConnectionStatus("disconnected");
        notify(ctx, "Claude Remote could not connect. Run /login for Anthropic, then /claude-remote on.", true);
      });
    } catch {
      stop();
      notify(ctx, "Claude Remote needs an Anthropic OAuth login. Use /login, then /claude-remote on.", true);
    }
  }

  function setEnabled(next: boolean, ctx: ExtensionContext): boolean {
    if (next) start(ctx);
    else stop();
    return enabled;
  }

  pi.registerCommand("claude-remote", {
    description: "Remote Control on/off",
    getArgumentCompletions: (prefix) => ["on", "off"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      const session = sessionEpoch;
      if (!action && ctx.mode === "tui") {
        await ctx.ui.custom((_tui, theme, _keys, done) => remoteControlPicker(
          theme, () => session === sessionEpoch && enabled,
          (next) => session === sessionEpoch && setEnabled(next, ctx), () => done(undefined),
        ));
      } else if (action === "on" || action === "off") {
        if (action === "on" && ctx.hasUI && !enabled && !await ctx.ui.confirm("Enable Remote Control?",
          "Share this session with Anthropic and control it from the Claude app. New sessions and reloads start Off.")) return;
        if (session !== sessionEpoch) return;
        setEnabled(action === "on", ctx);
      } else notify(ctx, "Usage: /claude-remote [on|off]", true);
    },
  });

  // Stop before pi changes the active session, including cancelled switches.
  pi.on("session_before_switch", () => { endSession(); });
  pi.on("session_before_fork", () => { endSession(); });
  pi.on("session_start", (_event, ctx) => {
    endSession();
    current = ctx;
    setConnectionStatus("off");
    // Intentionally ignore legacy PI_CLAUDE_REMOTE preferences. Every session,
    // including resumes, forks, reloads and workflow children, starts Off.
  });
  pi.on("session_shutdown", (_event, ctx) => {
    endSession();
    if (ctx.hasUI) ctx.ui.setStatus("claude-remote", undefined);
    current = undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    const wasActive = !!active;
    stop();
    current = ctx;
    if (wasActive) start(ctx); // an old branch's remote input must not control a new branch
  });
  pi.on("message_end", (event, ctx) => {
    current = ctx;
    if (!active) return;
    const message = event.message;
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content
        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const index = echoes.indexOf(text);
      if (index !== -1) { echoes.splice(index, 1); return; }
    }
    const outbound = mirrorMessage(message);
    if (outbound) active.send(outbound);
  });
  pi.on("agent_start", (_event, ctx) => { current = ctx; active?.reportState("running"); });
  pi.on("agent_end", (_event, ctx) => { current = ctx; active?.reportState("idle"); });
}

export default function claudeRemote(pi: ExtensionAPI): void { registerClaudeRemote(pi); }
