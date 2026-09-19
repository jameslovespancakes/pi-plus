import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentChatMessage, AgentRowSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import type { WorkflowProgressSource } from "../types.ts";
import { unknownErrorMessage } from "../unknown-error.ts";
import { formatWorkflowUsageLine } from "../usage.ts";
import { formatDuration, statusIcon, truncateDisplay } from "./workflow-format.ts";
import {
  centerWorkflowViewerViewport,
  fitWorkflowViewerRow,
  fitWorkflowViewerRows,
  workflowViewerHeight,
} from "./workflow-viewer-layout.ts";

export interface WorkflowInspectorOutcome {
  readonly label: string;
  readonly text: string;
}

type WorkflowInspectorLiveSource = Pick<WorkflowProgressSource, "conversation" | "followUp">;

interface BoardAgent {
  readonly agent: AgentRowSnapshot;
  readonly phase: string;
}

interface BoardRow {
  readonly text: string;
  readonly agentIndex?: number;
}

/** Modal board for inspecting workflow agents and sending targeted follow-ups. */
export class WorkflowInspector implements Focusable {
  private selected = 0;
  private detailAgentId: number | undefined;
  private detailScroll = 0;
  private clickRows = new Map<number, number>();
  private inputRow: number | undefined;
  private followUpError: string | undefined;
  private sending = false;
  private _focused = false;
  private readonly input: Input;
  private readonly snapshotProvider: () => WorkflowProgressSnapshot;
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Theme;
  private readonly close: () => void;
  private readonly outcome?: WorkflowInspectorOutcome;
  private readonly live?: WorkflowInspectorLiveSource;

  constructor(
    snapshotProvider: () => WorkflowProgressSnapshot,
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    close: () => void,
    outcome?: WorkflowInspectorOutcome,
    live?: WorkflowInspectorLiveSource,
  ) {
    this.snapshotProvider = snapshotProvider;
    this.tui = tui;
    this.theme = theme;
    this.close = close;
    this.outcome = outcome;
    this.live = live;
    this.input = new Input({
      prompt: "› ",
      placeholder: "Send a follow-up to this agent…",
      placeholderStyle: (text) => this.theme.fg("dim", text),
    });
    this.input.onSubmit = (value) => void this.submitFollowUp(value);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.detailAgentId !== undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || (data === "q" && this.detailAgentId === undefined)) {
      this.close();
      return;
    }

    if (this.detailAgentId !== undefined) {
      if (matchesKey(data, "pageUp")) this.scrollChat(6);
      else if (matchesKey(data, "pageDown")) this.scrollChat(-6);
      else if (matchesKey(data, "backspace") && this.input.getValue().length === 0) this.closeDetails();
      else if (this.canMessageSelectedAgent()) this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    const count = this.agents().length;
    if (matchesKey(data, "up") || data === "k") this.select(this.selected - 1, count);
    else if (matchesKey(data, "down") || data === "j") this.select(this.selected + 1, count);
    else if (matchesKey(data, "pageUp")) this.select(this.selected - 8, count);
    else if (matchesKey(data, "pageDown")) this.select(this.selected + 8, count);
    else if (matchesKey(data, "home") || data === "g") this.select(0, count);
    else if (matchesKey(data, "end") || data === "G") this.select(count - 1, count);
    else if (matchesKey(data, "return") || matchesKey(data, "enter") || data === " ") this.openDetails(count);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.detailAgentId !== undefined) {
      if (event.type === "wheel") {
        this.scrollChat(event.wheelDelta && event.wheelDelta < 0 ? 3 : -3);
        return { handled: true, focus: true, render: true };
      }
      if (event.type === "click" && event.button === "left" && event.y === this.inputRow && this.canMessageSelectedAgent()) {
        const result = this.input.handleMouse({ ...event, y: 0 });
        return { handled: true, focus: true, render: true, ...result };
      }
      return undefined;
    }

    const count = this.agents().length;
    if (event.type === "wheel") {
      this.select(this.selected + (event.wheelDelta && event.wheelDelta < 0 ? -3 : 3), count);
      return { handled: true, focus: true, render: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const index = this.clickRows.get(event.y);
    if (index === undefined) return undefined;
    this.selected = index;
    this.openDetails(count);
    return { handled: true, focus: true, render: true };
  }

  render(width: number): string[] {
    const outerWidth = Math.max(4, width);
    const innerWidth = Math.max(1, outerWidth - 4);
    const snapshot = this.snapshotProvider();
    const agents = this.agents(snapshot);
    this.selected = Math.min(Math.max(0, agents.length - 1), this.selected);

    const selected = this.detailAgentId === undefined
      ? undefined
      : agents.find((entry) => entry.agent.id === this.detailAgentId);
    if (this.detailAgentId !== undefined && !selected) this.closeDetails();

    const totalHeight = workflowViewerHeight(this.tui.terminal.rows);
    const innerHeight = Math.max(1, totalHeight - 2);
    const interior = selected
      ? this.chatInterior(selected, innerWidth, innerHeight)
      : this.boardInterior(snapshot, agents, innerWidth, innerHeight);

    return [
      this.theme.fg("border", `╭${"─".repeat(Math.max(0, outerWidth - 2))}╮`),
      ...interior.map((line) => this.frame(line, innerWidth)),
      this.theme.fg("border", `╰${"─".repeat(Math.max(0, outerWidth - 2))}╯`),
    ].map((line) => truncateDisplay(line, outerWidth));
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private boardInterior(
    snapshot: WorkflowProgressSnapshot,
    agents: readonly BoardAgent[],
    width: number,
    height: number,
  ): string[] {
    this.inputRow = undefined;
    this.clickRows.clear();
    const bodyHeight = Math.max(0, height - 6);
    const rows = this.boardRows(snapshot, agents, width);
    const selectedRow = Math.max(0, rows.findIndex((row) => row.agentIndex === this.selected));
    const viewport = centerWorkflowViewerViewport(rows, bodyHeight, selectedRow);
    const body = fitWorkflowViewerRows(viewport.visible.map((row) => row.text), bodyHeight);

    viewport.visible.forEach((row, index) => {
      if (row.agentIndex !== undefined) this.clickRows.set(5 + index, row.agentIndex);
    });

    return fitWorkflowViewerRows([
      ` ${this.theme.fg("accent", this.theme.bold("Workflow"))} ${this.theme.fg("dim", snapshot.title)}`,
      ` ${this.summary(snapshot, agents)}`,
      this.theme.fg("dim", "─".repeat(width)),
      ` ${this.columns(width)}`,
      ...body,
      this.theme.fg("dim", "─".repeat(width)),
      ` ${this.theme.fg("dim", `↑↓ select · click/enter inspect · ${viewport.percentage}% · esc close`)}`,
    ], height);
  }

  private chatInterior(
    entry: BoardAgent,
    width: number,
    height: number,
  ): string[] {
    this.clickRows.clear();
    const { agent } = entry;
    const bodyHeight = Math.max(0, height - 6);
    const rows = this.chatRows(agent, width);
    const maxStart = Math.max(0, rows.length - bodyHeight);
    const start = Math.max(0, maxStart - this.detailScroll);
    const body = fitWorkflowViewerRows(rows.slice(start, start + bodyHeight), bodyHeight);
    const elapsed = agent.startedAt === undefined ? "queued" : formatDuration((agent.doneAt ?? Date.now()) - agent.startedAt);
    const details = [
      shortModel(agent.model ?? "host default"),
      entry.phase,
      elapsed,
      `${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}`,
    ].join(this.theme.fg("dim", " · "));
    const canMessage = agent.status === "running" && this.live !== undefined;
    this.input.focused = this._focused && canMessage;
    this.inputRow = canMessage ? height - 1 : undefined;
    const inputLine = canMessage
      ? this.input.render(Math.max(1, width - 1))[0] ?? ""
      : this.theme.fg("dim", agent.status === "queued" ? "Agent has not started yet." : "Agent has finished.");
    const help = this.followUpError
      ? this.theme.fg("error", truncateDisplay(this.followUpError, Math.max(1, width - 1)))
      : this.theme.fg("dim", "enter send · page up/down scroll · backspace agents · esc close");

    return fitWorkflowViewerRows([
      ` ${statusIcon(agent.status, this.theme)} ${this.theme.fg("accent", this.theme.bold(agent.label))}`,
      ` ${details}`,
      this.theme.fg("dim", "─".repeat(width)),
      ...body,
      this.theme.fg("dim", "─".repeat(width)),
      ` ${inputLine}`,
      ` ${help}`,
    ], height);
  }

  private agents(snapshot = this.snapshotProvider()): BoardAgent[] {
    return snapshot.phases.flatMap((phase) => phase.agents.map((agent) => ({ phase: phase.title, agent })));
  }

  private select(index: number, count: number): void {
    if (count === 0) return;
    this.selected = Math.min(count - 1, Math.max(0, index));
    this.tui.requestRender();
  }

  private openDetails(count: number): void {
    if (count === 0) return;
    const entry = this.agents()[this.selected];
    if (!entry) return;
    this.detailAgentId = entry.agent.id;
    this.detailScroll = 0;
    this.followUpError = undefined;
    this.input.focused = this._focused;
    this.tui.requestRender();
  }

  private closeDetails(): void {
    this.detailAgentId = undefined;
    this.detailScroll = 0;
    this.followUpError = undefined;
    this.input.setValue("");
    this.input.focused = false;
    this.tui.requestRender();
  }

  private scrollChat(delta: number): void {
    this.detailScroll = Math.max(0, this.detailScroll + delta);
    this.tui.requestRender();
  }

  private canMessageSelectedAgent(): boolean {
    if (this.detailAgentId === undefined || !this.live || this.sending) return false;
    return this.agents().some((entry) => entry.agent.id === this.detailAgentId && entry.agent.status === "running");
  }

  private async submitFollowUp(value: string): Promise<void> {
    const message = value.trim();
    const agentId = this.detailAgentId;
    if (!message || agentId === undefined || !this.live || this.sending) return;
    this.sending = true;
    this.followUpError = undefined;
    this.input.setValue("");
    this.tui.requestRender();
    try {
      await this.live.followUp(agentId, message);
      this.detailScroll = 0;
    } catch (error) {
      this.followUpError = unknownErrorMessage(error);
      this.input.setValue(message);
    } finally {
      this.sending = false;
      this.tui.requestRender();
    }
  }

  private boardRows(snapshot: WorkflowProgressSnapshot, agents: readonly BoardAgent[], width: number): BoardRow[] {
    if (agents.length === 0) {
      return [{ text: ` ${this.theme.fg("dim", "No agents yet. Tasks appear here when the workflow starts.")}` }];
    }

    const rows: BoardRow[] = agents.map((entry, index) => ({
      text: this.agentRow(entry, index, width),
      agentIndex: index,
    }));
    const latestLog = snapshot.logs.at(-1);
    if (latestLog) rows.push({ text: ` ${this.theme.fg("dim", `Latest · ${latestLog}`)}` });
    if (this.outcome) {
      rows.push({ text: ` ${this.theme.fg("accent", this.outcome.label)}` });
      rows.push(...wrapTextWithAnsi(this.outcome.text, Math.max(1, width - 2)).slice(0, 12).map((text) => ({ text: ` ${text}` })));
    }
    return rows;
  }

  private chatRows(agent: AgentRowSnapshot, width: number): string[] {
    const messages = this.live?.conversation(agent.id) ?? [];
    if (messages.length === 0) return [` ${this.theme.fg("dim", "Waiting for agent activity…")}`];
    return messages.flatMap((message) => this.chatMessageRows(message, width));
  }

  private chatMessageRows(message: AgentChatMessage, width: number): string[] {
    const label = chatLabel(message);
    const timestamp = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const color = message.role === "status" ? "error" : message.role === "user" ? "accent" : message.role === "tool" ? "muted" : "text";
    const prefix = `${this.theme.fg("dim", timestamp)}  ${this.theme.fg(color, label.padEnd(6))} `;
    return wrapTextWithAnsi(`${prefix}${message.text}`, Math.max(1, width - 1)).map((line) => ` ${line}`);
  }

  private agentRow(entry: BoardAgent, index: number, width: number): string {
    const { agent } = entry;
    const selected = index === this.selected;
    const marker = selected ? this.theme.fg("accent", "▸") : " ";
    const taskWidth = Math.max(12, Math.floor(width * 0.36));
    const modelWidth = Math.max(12, Math.floor(width * 0.28));
    const activityWidth = Math.max(8, width - taskWidth - modelWidth - 7);
    const task = this.cell(agent.label, taskWidth, agent.status === "failed" ? "error" : "text");
    const model = this.cell(shortModel(agent.model ?? "host default"), modelWidth, "muted");
    const activity = this.cell(agentActivity(agent), activityWidth, agent.status === "failed" ? "error" : "dim");
    const row = `${marker} ${statusIcon(agent.status, this.theme)} ${task} ${model} ${activity}`;
    return selected ? this.theme.bg("selectedBg", fitWorkflowViewerRow(row, width)) : fitWorkflowViewerRow(row, width);
  }

  private columns(width: number): string {
    const taskWidth = Math.max(12, Math.floor(width * 0.36));
    const modelWidth = Math.max(12, Math.floor(width * 0.28));
    return this.theme.fg("dim", `  ${"Task".padEnd(taskWidth + 2)}${"Model".padEnd(modelWidth + 1)}Activity`);
  }

  private summary(snapshot: WorkflowProgressSnapshot, agents: readonly BoardAgent[]): string {
    const counts = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const { agent } of agents) counts[agent.status]++;
    const parts = [
      this.theme.fg("accent", snapshot.currentPhase),
      `${counts.running} running`,
      `${counts.queued} queued`,
      this.theme.fg("success", `${counts.done} done`),
      ...(counts.failed > 0 ? [this.theme.fg("error", `${counts.failed} failed`)] : []),
      formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt),
      formatWorkflowUsageLine(snapshot.usage) ?? "",
    ].filter(Boolean);
    return parts.join(this.theme.fg("dim", " · "));
  }

  private cell(text: string, width: number, color: Parameters<Theme["fg"]>[0]): string {
    const value = truncateDisplay(text, width);
    return this.theme.fg(color, value + " ".repeat(Math.max(0, width - visibleWidth(value))));
  }

  private frame(content: string, width: number): string {
    const fitted = fitWorkflowViewerRow(content, width);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
    return `${this.theme.fg("border", "│")} ${fitted}${padding} ${this.theme.fg("border", "│")}`;
  }
}

function chatLabel(message: AgentChatMessage): string {
  if (message.role === "task") return "Task";
  if (message.role === "user") return "You";
  if (message.role === "assistant") return "Agent";
  if (message.role === "tool") return "Tool";
  return "Status";
}

function shortModel(model: string): string {
  return model.replace(/^openai-codex\//, "codex/").replace(/^anthropic\//, "");
}

function agentActivity(agent: AgentRowSnapshot): string {
  if (agent.status === "queued") return "queued";
  if (agent.status === "failed") return agent.error ?? "failed";
  const parts: string[] = [];
  if (agent.lastTool) parts.push(agent.lastTool);
  if (agent.toolUses > 0) parts.push(`${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}`);
  if (agent.startedAt !== undefined) parts.push(formatDuration((agent.doneAt ?? Date.now()) - agent.startedAt));
  return parts.join(" · ") || agent.status;
}
