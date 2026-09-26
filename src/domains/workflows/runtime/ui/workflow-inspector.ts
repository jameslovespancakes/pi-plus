import { CustomEditor, getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { AgentTranscriptView } from "./agent-transcript.ts";
import {
  Box,
  Editor,
  Markdown,
  matchesKey,
  Text,
  type Focusable,
  type MarkdownTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentChatMessage, AgentRowSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import type { WorkflowProgressSource } from "../types.ts";
import { unknownErrorMessage } from "../unknown-error.ts";
import { agentModelName, thinkingLabel } from "./workflow-widget.ts";
import { formatDuration, statusIcon, truncateDisplay } from "./workflow-format.ts";
import {
  centerWorkflowViewerViewport,
  fitWorkflowViewerRow,
  fitWorkflowViewerRows,
} from "./workflow-viewer-layout.ts";

export const WORKFLOW_INSPECTOR_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
} as const;

export interface WorkflowInspectorOutcome {
  readonly label: string;
  readonly text: string;
}

type WorkflowInspectorLiveSource = Pick<WorkflowProgressSource, "conversation" | "followUp" | "stopAgent" | "transcript">;

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
  private width = 0;
  private detailAgentId: number | undefined;
  private detailScroll = 0;
  private clickRows = new Map<number, number>();
  private inputRow: number | undefined;
  private followUpError: string | undefined;
  private sending = false;
  private _focused = false;
  private readonly input: Editor;
  private readonly transcriptViews = new Map<number, AgentTranscriptView>();
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
    keybindings?: KeybindingsManager,
  ) {
    this.snapshotProvider = snapshotProvider;
    this.tui = tui;
    this.theme = theme;
    this.close = close;
    this.outcome = outcome;
    this.live = live;
    const editorTheme = { borderColor: (text: string) => this.theme.fg("border", text), selectList: getSelectListTheme() };
    this.input = keybindings
      ? new CustomEditor(tui as TUI, editorTheme, keybindings)
      : new Editor(tui as TUI, editorTheme);
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
      if (this.detailAgentId !== undefined) this.closeDetails();
      else this.close();
      return;
    }

    if (this.detailAgentId !== undefined) {
      if (matchesKey(data, "pageUp")) this.scrollChat(6);
      else if (matchesKey(data, "pageDown")) this.scrollChat(-6);
      else if (matchesKey(data, "backspace") && this.input.getText().length === 0) this.closeDetails();
      else if (matchesKey(data, "alt+enter") && this.canMessageSelectedAgent()) void this.submitFollowUp(this.input.getText(), false);
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
    else if (data === "x" || data === "X") this.stopSelectedAgent();
    else if (matchesKey(data, "return") || matchesKey(data, "enter") || data === " ") this.openDetails(count);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.detailAgentId !== undefined) {
      if (event.type === "wheel") {
        this.scrollChat(event.wheelDelta && event.wheelDelta < 0 ? 3 : -3);
        return { handled: true, focus: true, render: true };
      }
      if (event.type === "click" && event.button === "left" && event.y === this.inputRow && this.canMessageSelectedAgent()) {
        const result = this.input.handleMouse({ ...event, y: event.y - (this.inputRow ?? 0) });
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
    this.width = width;
    if (!this.canInspect() && this.detailAgentId !== undefined) this.closeDetails();
    const outerWidth = Math.max(4, width);
    const innerWidth = Math.max(1, outerWidth - 4);
    const snapshot = this.snapshotProvider();
    const agents = this.agents(snapshot);
    this.selected = Math.min(Math.max(0, agents.length - 1), this.selected);

    const selected = this.detailAgentId === undefined
      ? undefined
      : agents.find((entry) => entry.agent.id === this.detailAgentId);
    if (this.detailAgentId !== undefined && !selected) this.closeDetails();

    const totalHeight = Math.max(3, this.tui.terminal.rows - 1);
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
      ` ${this.followUpError ? this.theme.fg("error", this.followUpError) : this.theme.fg("dim", `↑↓ select · ${this.canInspect() ? "enter inspect" : "resize to inspect (80×24)"} · X stop · esc back`)}`,
    ], height);
  }

  private chatInterior(
    entry: BoardAgent,
    width: number,
    height: number,
  ): string[] {
    this.clickRows.clear();
    const { agent } = entry;
    const canMessage = agent.status === "running" && this.live !== undefined;
    this.input.focused = this._focused && canMessage;
    const editorLines = canMessage ? this.input.render(Math.max(1, width - 1))
      : [this.theme.fg("dim", agent.status === "queued" ? "Agent has not started yet." : "Agent has finished.")];
    const transcript = this.live?.transcript?.(agent.id);
    const queue = [...(transcript?.steering ?? []), ...(transcript?.followUp ?? [])];
    const queueLines = queue.length ? [this.theme.fg("dim", truncateDisplay(`Queued: ${queue.join(" · ")}`, width))] : [];
    const bodyHeight = Math.max(0, height - 5 - editorLines.length - queueLines.length);
    const rows = this.chatRows(agent, width);
    const maxStart = Math.max(0, rows.length - bodyHeight);
    const start = Math.max(0, maxStart - this.detailScroll);
    const body = fitWorkflowViewerRows(rows.slice(start, start + bodyHeight), bodyHeight);
    const elapsed = agent.startedAt === undefined ? "queued" : formatDuration((agent.doneAt ?? Date.now()) - agent.startedAt);
    const details = [
      agentModelName(agent),
      thinkingLabel(agent.thinkingLevel),
      elapsed,
    ].join(this.theme.fg("dim", " · "));
    this.inputRow = canMessage ? 4 + bodyHeight + queueLines.length : undefined;
    const help = this.followUpError
      ? this.theme.fg("error", truncateDisplay(this.followUpError, Math.max(1, width - 1)))
      : this.theme.fg("dim", "enter steer · alt+enter queue · /model · /thinking · esc back");

    return fitWorkflowViewerRows([
      ` ${statusIcon(agent.status, this.theme)} ${this.theme.fg("accent", this.theme.bold(agent.label))}`,
      ` ${details}`,
      this.theme.fg("dim", "─".repeat(width)),
      ...body,
      ...queueLines,
      ...editorLines,
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

  private canInspect(): boolean {
    return this.width >= 80 && this.tui.terminal.rows >= 24;
  }

  private stopSelectedAgent(): void {
    const agent = this.agents()[this.selected]?.agent;
    if (!agent || !this.live?.stopAgent) return;
    try {
      this.live.stopAgent(agent.id);
    } catch (error) {
      this.followUpError = unknownErrorMessage(error);
    }
    this.tui.requestRender();
  }

  private openDetails(count: number): void {
    if (count === 0 || !this.canInspect()) return;
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
    this.input.setText("");
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

  private async submitFollowUp(value: string, steer = true): Promise<void> {
    const message = value.trim();
    const agentId = this.detailAgentId;
    if (!message || agentId === undefined || !this.live || this.sending) return;
    this.sending = true;
    this.followUpError = undefined;
    this.input.setText("");
    this.tui.requestRender();
    try {
      await this.live.followUp(agentId, message, steer);
      this.detailScroll = 0;
    } catch (error) {
      this.followUpError = unknownErrorMessage(error);
      this.input.setText(message);
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
    const transcript = this.live?.transcript?.(agent.id);
    if (transcript) {
      let view = this.transcriptViews.get(agent.id);
      if (!view) { view = new AgentTranscriptView(); this.transcriptViews.set(agent.id, view); }
      return view.render(transcript, width, this.tui as TUI, transcript.cwd ?? process.cwd());
    }
    const messages = this.live?.conversation(agent.id) ?? [];
    if (messages.length === 0) return [` ${this.theme.fg("dim", "Waiting for agent activity…")}`];
    return messages.flatMap((message) => this.chatMessageRows(message, width));
  }

  private chatMessageRows(message: AgentChatMessage, width: number): string[] {
    if (message.role === "task" || message.role === "user") {
      const box = new Box(1, 1, (text) => this.theme.bg("userMessageBg", text));
      box.addChild(new Markdown(
        message.text,
        0,
        0,
        this.markdownTheme(),
        { color: (text) => this.theme.fg("userMessageText", text) },
        { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
      ));
      return box.render(width);
    }

    if (message.role === "assistant") {
      return ["", ...new Markdown(message.text, 1, 0, this.markdownTheme()).render(width)];
    }

    if (message.role === "tool") {
      const box = new Box(1, 0, (text) => this.theme.bg("toolPendingBg", text));
      box.addChild(new Text(this.theme.fg("toolTitle", this.theme.bold(message.text)), 0, 0));
      return box.render(width);
    }

    return [
      "",
      ...new Text(this.theme.fg("error", message.text), 1, 0).render(width),
    ];
  }

  private markdownTheme(): MarkdownTheme {
    return {
      heading: (text) => this.theme.fg("mdHeading", text),
      link: (text) => this.theme.fg("mdLink", text),
      linkUrl: (text) => this.theme.fg("mdLinkUrl", text),
      code: (text) => this.theme.fg("mdCode", text),
      codeBlock: (text) => this.theme.fg("mdCodeBlock", text),
      codeBlockBorder: (text) => this.theme.fg("mdCodeBlockBorder", text),
      quote: (text) => this.theme.fg("mdQuote", text),
      quoteBorder: (text) => this.theme.fg("mdQuoteBorder", text),
      hr: (text) => this.theme.fg("mdHr", text),
      listBullet: (text) => this.theme.fg("mdListBullet", text),
      bold: (text) => this.theme.bold(text),
      italic: (text) => this.theme.italic(text),
      strikethrough: (text) => this.theme.strikethrough(text),
      underline: (text) => this.theme.underline(text),
    };
  }

  private agentRow(entry: BoardAgent, index: number, width: number): string {
    const { agent } = entry;
    const selected = index === this.selected;
    const marker = selected ? this.theme.fg("accent", "▸") : " ";
    const taskWidth = Math.max(12, Math.floor(width * 0.36));
    const modelWidth = Math.max(12, Math.floor(width * 0.28));
    const activityWidth = Math.max(8, width - taskWidth - modelWidth - 7);
    const task = this.cell(agent.label, taskWidth, agent.status === "failed" ? "error" : "text");
    const model = this.cell(agentModelName(agent), modelWidth, "muted");
    const activity = this.cell(thinkingLabel(agent.thinkingLevel), activityWidth, "dim");
    const row = `${marker} ${statusIcon(agent.status, this.theme)} ${task} ${model} ${activity}`;
    return selected ? this.theme.bg("selectedBg", fitWorkflowViewerRow(row, width)) : fitWorkflowViewerRow(row, width);
  }

  private columns(width: number): string {
    const taskWidth = Math.max(12, Math.floor(width * 0.36));
    const modelWidth = Math.max(12, Math.floor(width * 0.28));
    return this.theme.fg("dim", `  ${"Task".padEnd(taskWidth + 2)}${"Model".padEnd(modelWidth + 1)}Thinking`);
  }

  private summary(snapshot: WorkflowProgressSnapshot, agents: readonly BoardAgent[]): string {
    const done = agents.filter(({ agent }) => agent.status === "done").length;
    const parts = [
      `${done}/${agents.length} done`,
      formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt),
    ];
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
