import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { type BoardMessage, type Priority, type ThreadInfo } from "./types.ts";
import { BoardClient } from "./client.ts";

const MESSAGE_MAX = 8_000;

export class BoardView implements Component, Focusable {
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
