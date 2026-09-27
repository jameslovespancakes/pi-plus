import os from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { handleBoardAdmin, registerBoardLifecycle } from "./board-setup.ts";
import { cleanLine, formatBoardDeliveries, type BoardDelivery } from "./format.ts";
import { loadConfig } from "./config.ts";
import { BoardClient } from "./client.ts";
import { type AgentInfo, type BoardMessage, type GitInfo, type ThreadInfo } from "./types.ts";
import { readGit } from "./presence.ts";
import { BoardView } from "./view.ts";

const DELIVERY_DEBOUNCE_MS = 250;

const DELIVERY_BATCH_MAX = 8;

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  if (!config) return;
  const client = new BoardClient(config);
  let ctx: ExtensionContext | undefined;
  let self: AgentInfo | undefined;
  let gitInfo: GitInfo = {};
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
  pi.on("before_agent_start", (event) => {
    client.presence({ state: "thinking", lastPrompt: cleanLine(event.prompt) });
    client.activity("prompt", event.prompt);
  });
  pi.on("tool_execution_start", async (event) => {
    const lastTool = cleanLine(`${event.toolName}: ${JSON.stringify(event.args)}`, 100);
    client.presence({ state: "tool", lastTool }); client.activity("tool", lastTool);
  });
  pi.on("tool_execution_end", async () => client.presence({ state: "thinking" }));
  pi.on("agent_settled", async () => { client.presence({ state: "idle", lastTool: undefined }); refreshGit(); });
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
