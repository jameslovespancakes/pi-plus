import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import WebSocket from "ws";
import { env } from "../../core/env.ts";
import { handleBoardAdmin, registerBoardLifecycle } from "./board-setup.ts";
import { formatBoardDeliveries, formatBoardSnapshot, type BoardDelivery } from "./format.ts";

const HEARTBEAT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 2_000;
const SNAPSHOT_CACHE_MS = 1_500;
const MESSAGE_MAX = 8_000;
const DELIVERY_DEBOUNCE_MS = 250;
const DELIVERY_BATCH_MAX = 8;

type State = "idle" | "thinking" | "tool";
type Priority = "normal" | "urgent";

interface Config { url: string; token: string; adminName?: string; }
interface AgentInfo {
  sessionId: string; alias?: string; host: string; cwd: string; branch?: string;
  repo?: string; commit?: string; commitTime?: number; commitSubject?: string;
  model?: string; state: State; lastTool?: string; lastPrompt?: string; lastSeenAt?: number;
  key?: string; coordinator?: string | null; reports?: string[];
}
interface ThreadInfo { id: string; kind: "direct" | "group"; title?: string; auto?: boolean; repoKey?: string; participantIds: string[]; participants: AgentInfo[]; lastMessage?: BoardMessage | null; }
interface Coordination { key?: string; coordinator?: string | null; reports?: string[]; repoThread?: string; }
interface BoardMessage { id: string; threadId: string; senderType: "user" | "agent"; senderId: string; senderAlias?: string; text: string; priority: Priority; createdAt: number; }
interface GitInfo { branch?: string; repo?: string; commit?: string; commitTime?: number; commitSubject?: string; dirty?: boolean; }

type Listener = (event: any) => void;

function configDir(): string { return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"); }
function loadConfig(): Config | undefined {
  // Unified store first; the standalone agent-board.json is still honoured.
  const url = env("AGENT_BOARD_URL");
  const token = env("AGENT_BOARD_TOKEN");
  if (url && token) return { url, token, adminName: env("AGENT_BOARD_NAME") };
  try {
    const value = JSON.parse(fs.readFileSync(path.join(configDir(), "agent-board.json"), "utf8"));
    if (typeof value.url === "string" && typeof value.token === "string") return value;
  } catch {}
  return undefined;
}
function cleanLine(value: unknown, max = 140): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}
function normalizeRemote(remote?: string): string | undefined {
  if (!remote) return undefined;
  return remote.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").toLowerCase();
}
function readGit(cwd: string): GitInfo {
  const meta = git(cwd, ["show", "-s", "--format=%H%n%ct%n%s", "HEAD"])?.split("\n") ?? [];
  return {
    branch: git(cwd, ["branch", "--show-current"]),
    repo: normalizeRemote(git(cwd, ["remote", "get-url", "origin"])) ?? git(cwd, ["rev-parse", "--show-toplevel"]),
    commit: meta[0],
    commitTime: meta[1] ? Number(meta[1]) * 1_000 : undefined,
    commitSubject: meta[2],
    dirty: Boolean(git(cwd, ["status", "--porcelain"])),
  };
}

class BoardClient {
  private ws?: WebSocket;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempts = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<Listener>();
  private agent?: AgentInfo;
  connected = false;
  coordination: Coordination = {};

  constructor(private readonly config: Config) {}
  start(agent: AgentInfo): void { this.agent = agent; this.stopped = false; this.connect(); }
  stop(): void {
    this.stopped = true; this.connected = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000, "pi session shutdown"); this.ws = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Agent board disconnected")); }
    this.pending.clear();
  }
  on(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: any): void { for (const listener of this.listeners) { try { listener(event); } catch {} } }
  private connect(): void {
    if (this.stopped || !this.agent) return;
    const ws = new WebSocket(this.config.url);
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ t: "register", token: this.config.token, agent: this.agent })));
    ws.on("message", (raw) => {
      let value: any; try { value = JSON.parse(raw.toString()); } catch { return; }
      if (value.t === "registered") {
        this.connected = true; this.attempts = 0;
        this.coordination = { key: value.key, coordinator: value.coordinator, reports: value.reports, repoThread: value.repoThread };
        this.emit({ t: "connection", connected: true });
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.presence({}), HEARTBEAT_MS); this.heartbeat.unref?.();
      } else if (value.t === "coordination") {
        this.coordination = { ...this.coordination, key: value.key, coordinator: value.coordinator, reports: value.reports };
        this.emit(value);
      } else if (value.t === "thread") {
        this.emit(value);
      } else if (value.t === "res") {
        const item = this.pending.get(value.id); if (!item) return;
        this.pending.delete(value.id); clearTimeout(item.timer);
        if (value.ok) item.resolve(value.data);
        else item.reject(new Error(value.error || "Board request failed"));
      } else if (value.t === "message") this.emit(value);
    });
    const disconnected = () => {
      if (this.ws !== ws) return;
      this.connected = false; this.emit({ t: "connection", connected: false });
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) {
        const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts++, 5));
        this.reconnect = setTimeout(() => this.connect(), delay); this.reconnect.unref?.();
      }
    };
    ws.once("close", disconnected); ws.once("error", disconnected);
  }
  presence(patch: Partial<AgentInfo>): void {
    if (!this.agent) return;
    this.agent = { ...this.agent, ...patch };
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) this.ws.send(JSON.stringify({ t: "presence", agent: patch }));
  }
  activity(type: string, summary: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected) this.ws.send(JSON.stringify({ t: "activity", event: { type, summary: cleanLine(summary), at: Date.now() } }));
  }
  request(action: string, input: Record<string, unknown> = {}, timeout = REQUEST_TIMEOUT_MS): Promise<any> {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Agent board is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Agent board request timed out")); }, timeout);
      timer.unref?.(); this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ t: "req", id, action, ...input }));
    });
  }
}

class BoardView implements Component, Focusable {
  private input = new Input();
  private threads: ThreadInfo[] = [];
  private messages: BoardMessage[] = [];
  private selected = 0;
  private sending = false;
  private error?: string;
  private initialRecipients?: string[];
  private subscribedThread?: string;
  private unsubscribe: () => void;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(
    private readonly client: BoardClient,
    private readonly tui: any,
    private readonly theme: any,
    private readonly done: () => void,
    recipients: string[],
  ) {
    this.initialRecipients = recipients.length ? recipients : undefined;
    this.input.onSubmit = (value) => void this.send(value, "normal");
    this.input.onEscape = () => this.close();
    this.unsubscribe = client.on((event) => {
      if (event.t === "connection") {
        this.error = event.connected ? undefined : "Messaging Board is offline, reconnecting…";
        if (event.connected) void this.load();
        this.tui.requestRender();
        return;
      }
      if (event.t !== "message") return;
      const index = this.threads.findIndex((thread) => thread.id === event.thread.id);
      if (index < 0) this.threads.unshift(event.thread); else this.threads[index] = event.thread;
      if (this.current()?.id === event.message.threadId) this.messages.push(event.message);
      this.tui.requestRender();
    });
    void this.load();
  }
  private current(): ThreadInfo | undefined { return this.threads[this.selected]; }
  private async load(): Promise<void> {
    try {
      this.threads = await this.client.request("threads", { actor: "user" });
      if (this.threads.length) await this.loadMessages();
    } catch (error) { this.error = (error as Error).message; }
    this.tui.requestRender();
  }
  private async loadMessages(): Promise<void> {
    const thread = this.current();
    if (!thread) { this.messages = []; return; }
    try {
      const previous = this.subscribedThread;
      this.subscribedThread = thread.id;
      await this.client.request("subscribe", { actor: "user", thread: thread.id, previous });
      this.messages = (await this.client.request("messages", { actor: "user", thread: thread.id, limit: 100 })).messages;
    } catch (error) { this.error = (error as Error).message; }
  }
  private async send(value: string, priority: Priority): Promise<void> {
    const text = value.trim(); if (!text || this.sending) return;
    this.sending = true; this.error = undefined;
    try {
      const result = await this.client.request("send", {
        actor: "user", thread: this.current()?.id, recipients: this.current() ? undefined : this.initialRecipients,
        message: text.slice(0, MESSAGE_MAX), priority,
      });
      if (!this.current()) {
        this.threads.unshift(result.thread); this.selected = 0; this.initialRecipients = undefined;
        await this.client.request("subscribe", { actor: "user", thread: result.thread.id, previous: this.subscribedThread });
        this.subscribedThread = result.thread.id;
      }
      this.messages.push(result.message); this.input.setValue("");
    } catch (error) { this.error = (error as Error).message; }
    finally { this.sending = false; this.tui.requestRender(); }
  }
  private close(): void {
    this.unsubscribe();
    if (this.subscribedThread) void this.client.request("subscribe", { actor: "user", previous: this.subscribedThread }).catch(() => {});
    this.done();
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.close();
    if (matchesKey(data, Key.tab) && this.threads.length > 1) {
      this.selected = (this.selected + 1) % this.threads.length; void this.loadMessages(); this.tui.requestRender(); return;
    }
    if (matchesKey(data, Key.ctrl("enter"))) {
      const value = this.input.getValue();
      if (value) void this.send(value, "urgent");
      return;
    }
    this.input.handleInput(data); this.tui.requestRender();
  }
  invalidate(): void { this.input.invalidate(); }
  render(width: number): string[] {
    const w = Math.max(32, width);
    const inner = Math.max(1, w - 4);
    const th = this.theme;
    const status = this.client.connected
      ? `${th.fg("success", "●")} ${th.fg("success", th.bold("Active"))}`
      : `${th.fg("error", "●")} ${th.fg("error", th.bold("Offline"))}`;
    const tabs = this.threads.length
      ? this.threads.slice(0, 6).map((item, index) => {
          const label = ` ${index + 1} ${item.title || item.id.slice(0, 8)} `;
          return index === this.selected
            ? th.bg("selectedBg", th.fg("accent", th.bold(label)))
            : th.fg("muted", label);
        }).join(th.fg("dim", "│"))
      : th.fg("dim", this.initialRecipients ? ` New chat: ${this.initialRecipients.join(", ")} ` : " No chats. Use /board <agent> to start one ");
    const messageLines: string[] = [];
    for (const message of this.messages) {
      const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const sender = message.senderType === "user" ? "you" : (message.senderAlias || message.senderId.slice(0, 8));
      const marker = message.priority === "urgent" ? th.fg("warning", "!") : th.fg("dim", "›");
      const label = `${marker} ${message.senderType === "user" ? th.fg("success", th.bold(sender)) : th.fg("accent", th.bold(sender))} ${th.fg("dim", time)}`;
      messageLines.push(label);
      for (const line of wrapTextWithAnsi(message.text, Math.max(10, inner - 4))) messageLines.push(`  ${line}`);
      messageLines.push("");
    }
    if (!messageLines.length) messageLines.push(th.fg("dim", "No messages yet."));
    const popupHeight = Math.max(12, Math.min((this.tui.terminal?.rows ?? 30) - 6, 30));
    const bodyHeight = Math.max(3, popupHeight - 8 - (this.error ? 1 : 0));
    const visibleMessages = messageLines.slice(-bodyHeight);
    while (visibleMessages.length < bodyHeight) visibleMessages.unshift("");
    const inputLine = this.input.render(Math.max(1, inner - 11))[0] ?? "";
    const content = [
      `${th.fg("accent", th.bold("Messaging Board"))}  ${status}  ${th.fg("dim", `· ${this.threads.length} chat${this.threads.length === 1 ? "" : "s"}`)}`,
      tabs,
      th.fg("dim", "─".repeat(inner)),
      ...visibleMessages,
      th.fg("dim", "─".repeat(inner)),
      ...(this.error ? [th.fg("error", this.error)] : []),
      `${th.fg("accent", th.bold("Message"))} ${inputLine}`,
      th.fg("dim", "enter send · tab next chat · esc close"),
    ];
    const row = (value: string): string => {
      const fitted = truncateToWidth(value, inner, "");
      return `${th.fg("border", "│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${th.fg("border", "│")}`;
    };
    return [
      th.fg("border", `╭${"─".repeat(Math.max(0, w - 2))}╮`),
      ...content.map(row),
      th.fg("border", `╰${"─".repeat(Math.max(0, w - 2))}╯`),
    ];
  }
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  if (!config) return;
  const client = new BoardClient(config);
  let ctx: ExtensionContext | undefined;
  let self: AgentInfo | undefined;
  let gitInfo: GitInfo = {};
  let snapshot: { at: number; agents: AgentInfo[] } = { at: 0, agents: [] };
  let lastInjectedSnapshot: string | undefined;
  let pendingDeliveries: BoardDelivery[] = [];
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;

  const updateStatus = () => {
    if (!ctx?.hasUI) return;
    const color = client.connected ? "success" : "error";
    const label = client.connected ? "Active" : "Offline";
    ctx.ui.setStatus("agent-board", ctx.ui.theme.fg(color, `● Messaging Board ${label}`));
  };
  const refreshGit = () => {
    if (!ctx || !self) return;
    gitInfo = readGit(ctx.cwd);
    self = { ...self, ...gitInfo };
    client.presence(gitInfo);
  };
  const snapshotAgents = async (): Promise<AgentInfo[]> => {
    if (Date.now() - snapshot.at > SNAPSHOT_CACHE_MS) {
      snapshot = { at: Date.now(), agents: await client.request("agents", {}, 500) };
    }
    return snapshot.agents;
  };
  const flushDeliveries = () => {
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimer = undefined;
    const deliveries = pendingDeliveries;
    pendingDeliveries = [];
    if (!ctx || !deliveries.length) return;
    const urgent = deliveries.some(({ message }) => message.priority === "urgent");
    if (urgent && !ctx.isIdle()) ctx.abort();
    const details = deliveries.length === 1 ? deliveries[0] : { deliveries };
    pi.sendMessage(
      { customType: "agent-board", content: formatBoardDeliveries(deliveries), display: true, details },
      { deliverAs: "steer", triggerTurn: true },
    );
  };
  const queueDelivery = (delivery: BoardDelivery) => {
    pendingDeliveries.push(delivery);
    if (delivery.message.priority === "urgent" || pendingDeliveries.length >= DELIVERY_BATCH_MAX) {
      flushDeliveries();
      return;
    }
    if (deliveryTimer) return;
    deliveryTimer = setTimeout(flushDeliveries, DELIVERY_DEBOUNCE_MS);
    deliveryTimer.unref?.();
  };

  client.on((event) => {
    if (event.t === "connection") {
      if (event.connected) { snapshot.at = 0; lastInjectedSnapshot = undefined; }
      updateStatus();
      return;
    }
    if (event.t === "coordination") { updateStatus(); return; }
    if (event.t !== "message" || event.adminView || !ctx) return;
    queueDelivery({ message: event.message as BoardMessage, thread: event.thread as ThreadInfo });
  });

  pi.on("session_start", async (_event, eventCtx) => {
    if (!eventCtx.hasUI) return;
    ctx = eventCtx; gitInfo = readGit(eventCtx.cwd);
    self = {
      sessionId: eventCtx.sessionManager.getSessionId(), alias: pi.getSessionName(), host: os.hostname(), cwd: eventCtx.cwd,
      model: eventCtx.model ? `${eventCtx.model.provider}/${eventCtx.model.id}` : undefined, state: "idle", ...gitInfo,
    };
    client.start(self); updateStatus();
  });
  pi.on("session_info_changed", async (event) => { if (self) { self.alias = event.name; client.presence({ alias: event.name }); } });
  pi.on("model_select", async (event) => client.presence({ model: `${event.model.provider}/${event.model.id}` }));
  pi.on("before_agent_start", async (event) => {
    client.presence({ state: "thinking", lastPrompt: cleanLine(event.prompt) });
    client.activity("prompt", event.prompt);
    if (!client.connected) return;
    try {
      const content = formatBoardSnapshot(await snapshotAgents(), gitInfo, client.coordination);
      if (content === lastInjectedSnapshot) return;
      lastInjectedSnapshot = content;
      // Persist one compact snapshot at a user-turn boundary. A transient message
      // appended in `context` becomes Anthropic's final cache breakpoint but is
      // absent from the next transcript, forcing a conversation-cache miss.
      return { message: { customType: "agent-board-snapshot", content, display: false, details: {} } };
    } catch { return; }
  });
  pi.on("tool_execution_start", async (event) => {
    const lastTool = cleanLine(`${event.toolName}: ${JSON.stringify(event.args)}`, 100);
    client.presence({ state: "tool", lastTool }); client.activity("tool", lastTool);
  });
  pi.on("tool_execution_end", async () => client.presence({ state: "thinking" }));
  pi.on("agent_settled", async () => { client.presence({ state: "idle", lastTool: undefined }); refreshGit(); });
  pi.on("session_compact", async () => { lastInjectedSnapshot = undefined; });
  pi.on("session_tree", async () => { lastInjectedSnapshot = undefined; });
  pi.on("session_shutdown", async (_event, eventCtx) => {
    if (deliveryTimer) clearTimeout(deliveryTimer);
    deliveryTimer = undefined; pendingDeliveries = [];
    client.stop(); eventCtx.ui.setStatus("agent-board", undefined); ctx = undefined; self = undefined;
  });

  pi.registerMessageRenderer("agent-board", (message, _options, theme) => new Text(theme.fg("accent", message.content as string), 1, 0));

  registerBoardLifecycle(pi);

  pi.registerCommand("board", {
    description: "Live agent board, or setup | restart | clear | status",
    getArgumentCompletions: (prefix) =>
      ["setup", "restart", "clear", "status"]
        .filter((option) => option.startsWith(prefix))
        .map((option) => ({ value: option, label: option })),
    handler: async (args, commandCtx) => {
      // Admin verbs run without the TUI; anything else opens the board view.
      if (await handleBoardAdmin(pi, commandCtx, args)) return;
      if (commandCtx.mode !== "tui") { commandCtx.ui.notify("The Messaging Board UI requires TUI mode.", "warning"); return; }
      const recipients = args.split(/[ ,]+/).map((value) => value.trim()).filter(Boolean);
      await commandCtx.ui.custom<void>(
        (tui, theme, _keys, done) => new BoardView(client, tui, theme, done, recipients),
        { overlay: true, overlayOptions: { anchor: "center", width: "86%", minWidth: 56, maxHeight: "85%", margin: 1 } },
      );
    },
  });

  pi.registerTool({
    name: "agent_board",
    label: "Agent Board",
    description: "Consult and message all currently running local and remote Pi agents. Every agent record includes host, state, Git branch, and commit hash. Messages are live: idle agents wake immediately and busy agents see them at the next safe turn boundary. Stopped agents are never listed and messages are not queued for them. Agents working in the same repository share an auto-created repo room, and coordinators can be assigned so subordinate agents report their progress upward.",
    promptSnippet: "Consult live collaborators, report to your coordinator, and exchange direct, repo-room, or group messages",
    promptGuidelines: [
      "Consult the latest compact Live agent board snapshot before starting work; avoid duplicating work and compare Git commit hashes before relying on another agent's changes.",
      "Use agent_board to inform collaborators when their commit or assumptions appear outdated, and reply only when coordination is useful.",
      "If the board snapshot names a coordinator for you, use agent_board action 'report' to send them meaningful progress, blockers, and completed work instead of staying silent.",
      "Use agent_board action 'set_coordinator' when the user puts one agent in charge of others, and 'coordinators' to inspect the current reporting structure.",
      "Post repo-wide notices in the shared repo room thread so every agent in the same repository sees them.",
    ],
    parameters: Type.Object({
      action: StringEnum(["agents", "inspect", "threads", "read", "send", "report", "coordinators", "set_coordinator"] as const),
      agent: Type.Optional(Type.String({ description: "For inspect: session id prefix, alias, or cwd substring. For set_coordinator: the coordinator's alias, or 'none' to clear" })),
      thread: Type.Optional(Type.String({ description: "Thread id for read/send/reply" })),
      recipients: Type.Optional(Type.Array(Type.String(), { description: "Active agent aliases or ids for a new direct/group chat; for set_coordinator, the agents that should report to the coordinator (defaults to yourself)" })),
      message: Type.Optional(Type.String({ description: "Message text for send or report" })),
      priority: Type.Optional(StringEnum(["normal", "urgent"] as const)),
      limit: Type.Optional(Type.Number({ description: "Maximum messages/activity events to return" })),
    }),
    async execute(_id, params) {
      const action = params.action === "read" ? "messages" : params.action;
      const { action: _requestedAction, ...input } = params;
      const data = await client.request(action, { ...input, actor: "agent" });
      let text: string;
      if (params.action === "agents") {
        const agents = data as AgentInfo[];
        text = agents.length ? agents.map((agent) => `${agent.sessionId.slice(0, 8)} ${agent.alias || "(unnamed)"}\n  ${agent.host} · ${agent.cwd}\n  ${agent.state}${agent.lastTool ? ` · ${agent.lastTool}` : ""}\n  git ${agent.branch || "-"}@${agent.commit?.slice(0, 12) || "no-commit"}${agent.commitSubject ? ` · ${agent.commitSubject}` : ""}`).join("\n") : "No other Pi agents are currently running.";
      } else if (params.action === "send" || params.action === "report") {
        text = `Delivered to: ${data.delivered.join(", ") || "none"}.${data.notRunning.length ? ` Not running: ${data.notRunning.join(", ")}.` : ""} Thread: ${data.thread.id}`;
      } else if (params.action === "set_coordinator") {
        text = data.applied.length
          ? data.applied.map((item: any) => item.coordinator ? `${item.agent} now reports to ${item.coordinator}` : `${item.agent} no longer has a coordinator`).join("\n")
          : "No agents matched; nothing changed.";
      } else if (params.action === "coordinators") {
        const links = (data.links as any[]).map((link) => `${link.agent}${link.agentOnline ? "" : " (offline)"} → ${link.coordinator}${link.coordinatorOnline ? "" : " (offline)"}`);
        text = [
          data.self.coordinator ? `You report to: ${data.self.coordinator}` : "You have no coordinator.",
          data.self.reports.length ? `Reporting to you: ${data.self.reports.join(", ")}` : "No agents report to you.",
          links.length ? `\nAll links:\n${links.join("\n")}` : "\nNo coordinator links are configured.",
        ].join("\n");
      } else text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text", text }], details: data };
    },
  });
}
