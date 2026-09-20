const DELIVERY_TEXT_MAX = 2_000;

export interface SnapshotAgent {
  sessionId: string;
  alias?: string;
  host: string;
  branch?: string;
  repo?: string;
  commit?: string;
  state: "idle" | "thinking" | "tool";
  lastTool?: string;
  coordinator?: string | null;
  reports?: string[];
}

export interface SnapshotSelf {
  branch?: string;
  repo?: string;
  commit?: string;
}

export interface SnapshotCoordination {
  coordinator?: string | null;
  reports?: string[];
  repoThread?: string;
}

export interface DeliveryMessage {
  senderId: string;
  senderAlias?: string;
  text: string;
  priority: "normal" | "urgent";
}

export interface DeliveryThread {
  id: string;
  title?: string;
}

export interface BoardDelivery {
  message: DeliveryMessage;
  thread: DeliveryThread;
}

function cleanLine(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function compactTool(lastTool?: string): string | undefined {
  if (!lastTool) return undefined;
  const separator = lastTool.indexOf(":");
  return cleanLine(separator < 0 ? lastTool : lastTool.slice(0, separator), 32);
}

export function formatBoardSnapshot(
  agents: readonly SnapshotAgent[],
  self: SnapshotSelf,
  coordination: SnapshotCoordination,
): string {
  const commit = self.commit?.slice(0, 12) || "no-commit";
  const meta = [
    `${self.branch || "-"}@${commit}`,
    `${agents.length} peer${agents.length === 1 ? "" : "s"}`,
    coordination.repoThread ? `room=${coordination.repoThread}` : undefined,
    coordination.coordinator ? `reports-to=${coordination.coordinator}` : undefined,
    coordination.reports?.length ? `reports=${coordination.reports.join(",")}` : undefined,
  ].filter(Boolean).join(" ");
  const lines = [`[board ${meta}]`];
  for (const agent of agents.slice(0, 12)) {
    const agentCommit = agent.commit?.slice(0, 12) || "no-commit";
    const sameLine = agent.repo && self.repo === agent.repo && agent.branch === self.branch;
    const drift = sameLine && agent.commit && self.commit && agent.commit !== self.commit ? " !commit" : "";
    const tool = agent.state === "tool" ? compactTool(agent.lastTool) : undefined;
    const activity = tool ? `tool:${tool}` : agent.state;
    const role = agent.reports?.length ? " coord" : agent.coordinator ? ` ->${agent.coordinator}` : "";
    lines.push(`- ${agent.alias || agent.sessionId.slice(0, 8)}@${agent.host} ${activity} ${agent.branch || "-"}@${agentCommit}${drift}${role}`);
  }
  if (agents.length > 12) lines.push(`- +${agents.length - 12} more; use agent_board agents`);
  return lines.join("\n");
}

function compactDeliveryText(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  if (clean.length <= DELIVERY_TEXT_MAX) return clean;
  return `${clean.slice(0, DELIVERY_TEXT_MAX - 1)}…\n[truncated; use agent_board read]`;
}

export function formatBoardDeliveries(deliveries: readonly BoardDelivery[]): string {
  const lines = [`[board${deliveries.some(({ message }) => message.priority === "urgent") ? " urgent" : ""} x${deliveries.length}]`];
  for (const { message, thread } of deliveries) {
    const sender = message.senderAlias || message.senderId.slice(0, 8);
    lines.push(`${message.priority === "urgent" ? "! " : ""}from=${sender} thread=${thread.id}${thread.title ? ` (${cleanLine(thread.title, 60)})` : ""}`);
    lines.push(compactDeliveryText(message.text));
  }
  return lines.join("\n");
}
