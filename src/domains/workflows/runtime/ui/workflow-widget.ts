import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRowSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import { formatWorkflowUsageLine } from "../usage.ts";
import { formatDuration, statusIcon } from "./workflow-format.ts";
import { toDisplayLine } from "./display-text.ts";

const MAX_WIDGET_LINES = 9;

/** Compact live board shown above the editor. */
export function renderWorkflowWidgetLines(snapshot: WorkflowProgressSnapshot, theme: Theme): string[] {
  const agents = snapshot.phases.flatMap((phase) => phase.agents);
  const ordered = [...agents].sort((left, right) => statusOrder(left.status) - statusOrder(right.status));
  const counts = countAgents(agents);
  const elapsed = formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt);
  const active = counts.running + counts.queued;
  const icon = active > 0 ? theme.fg("accent", "●") : theme.fg("success", "✓");
  const summary = [
    `${counts.running} running`,
    `${counts.queued} queued`,
    `${counts.done}/${counts.total} done`,
    ...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
    elapsed,
  ].join(` ${theme.fg("dim", "·")} `);
  const lines = [
    `${icon} ${theme.bold(snapshot.title)} ${theme.fg("dim", `· ${snapshot.currentPhase} · ${summary}`)}`,
  ];

  const footer = footerLine(snapshot, theme);
  const bodyLimit = Math.max(0, MAX_WIDGET_LINES - lines.length - 1);
  for (const agent of ordered.slice(0, bodyLimit)) lines.push(agentLine(agent, theme));
  const hidden = ordered.length - Math.min(ordered.length, bodyLimit);
  if (hidden > 0 && lines.length < MAX_WIDGET_LINES) {
    lines.push(theme.fg("dim", `  +${hidden} more · /workflow`));
  } else if (footer && lines.length < MAX_WIDGET_LINES) {
    lines.push(footer);
  }
  return lines.map((line) => line.replace(/[\r\n]+/g, " "));
}

interface AgentCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  total: number;
}

function countAgents(agents: readonly AgentRowSnapshot[]): AgentCounts {
  const counts: AgentCounts = { queued: 0, running: 0, done: 0, failed: 0, total: agents.length };
  for (const agent of agents) counts[agent.status]++;
  return counts;
}

function statusOrder(status: AgentRowSnapshot["status"]): number {
  return status === "running" ? 0 : status === "queued" ? 1 : status === "failed" ? 2 : 3;
}

function agentLine(agent: AgentRowSnapshot, theme: Theme): string {
  const model = toDisplayLine(shortModel(agent.model ?? "host default"), 48);
  const details: string[] = [];
  if (agent.lastTool) details.push(toDisplayLine(agent.lastTool, 32));
  if (agent.toolUses > 0) details.push(`${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}`);
  if (agent.startedAt !== undefined) details.push(formatDuration((agent.doneAt ?? Date.now()) - agent.startedAt));
  const activity = details.length > 0 ? ` ${theme.fg("dim", `· ${details.join(" · ")}`)}` : "";
  const color = agent.status === "failed" ? "error" : agent.status === "running" ? "text" : "muted";
  return `  ${statusIcon(agent.status, theme)} ${theme.fg(color, toDisplayLine(agent.label, 64))} ${theme.fg("accent", model)}${activity}`;
}

function footerLine(snapshot: WorkflowProgressSnapshot, theme: Theme): string {
  const usage = formatWorkflowUsageLine(snapshot.usage);
  const latest = snapshot.logs.at(-1);
  const parts = [usage, latest ? toDisplayLine(latest, 100) : undefined, "/workflow"].filter(Boolean);
  return theme.fg("dim", `  ${parts.join(" · ")}`);
}

function shortModel(model: string): string {
  return model.replace(/^openai-codex\//, "codex/").replace(/^anthropic\//, "");
}
