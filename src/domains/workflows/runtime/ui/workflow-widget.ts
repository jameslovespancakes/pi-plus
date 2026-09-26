import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import { formatDuration, statusIcon } from "./workflow-format.ts";
import { toDisplayLine } from "./display-text.ts";

export function thinkingLabel(level?: string): string {
  if (!level) return "—";
  return level === "xhigh" ? "XHigh" : level[0].toUpperCase() + level.slice(1);
}

export function agentModelName(agent: AgentRowSnapshot): string {
  return toDisplayLine(agent.modelName ?? agent.model ?? "—", 48);
}

/** Compact live board; detailed activity is available through /workflow. */
export function renderWorkflowWidgetLines(snapshot: WorkflowProgressSnapshot, theme: Theme): string[] {
  const agents = snapshot.phases.flatMap((phase) => phase.agents);
  const ordered = [...agents].sort((a, b) => order(a.status) - order(b.status));
  const done = agents.filter((agent) => agent.status === "done").length;
  const elapsed = formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt);
  const shown = ordered.slice(0, 7);
  const names = shown.map((agent) => toDisplayLine(agent.label, 32));
  const models = shown.map(agentModelName);
  const nameWidth = Math.max(0, ...names.map(visibleWidth));
  const modelWidth = Math.max(0, ...models.map(visibleWidth));
  const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
  const lines = [`${theme.bold(snapshot.title)} ${theme.fg("dim", `· ${done}/${agents.length} done · ${elapsed}`)}`];
  shown.forEach((agent, index) => lines.push(
    `  ${statusIcon(agent.status, theme)} ${pad(names[index], nameWidth)}  ${theme.fg("muted", pad(models[index], modelWidth))}  ${theme.fg("dim", thinkingLabel(agent.thinkingLevel))}`,
  ));
  if (agents.length > shown.length) lines.push(theme.fg("dim", `  +${agents.length - shown.length} more · /workflow`));
  return lines;
}

function order(status: AgentRowSnapshot["status"]): number {
  return status === "running" || status === "stopping" ? 0 : status === "queued" ? 1 : 2;
}
