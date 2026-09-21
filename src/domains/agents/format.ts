const DELIVERY_TEXT_MAX = 2_000;

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
