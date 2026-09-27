import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, WorkflowLaneItemStatus, WorkflowProgressSnapshot } from "../runs/progress-types.ts";
import { toDisplayLine } from "./display-text.ts";
import { formatWorkflowUsageLine, isWorkflowUsageSnapshot } from "../execution/usage.ts";

/** Display-only formatting: never change workflow identifiers or persisted names. */
export function formatWorkflowTitle(name: string): string {
  return toDisplayLine(name, 120).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/(^|\s)\p{L}/gu, (letter) => letter.toUpperCase());
}

export function formatWorkflowHeading(name: string, usage: unknown, theme: Theme): string {
  const title = theme.fg("accent", theme.bold(formatWorkflowTitle(name)));
  return isWorkflowUsageSnapshot(usage)
    ? `${title}${theme.fg("dim", ` · $${usage.totals.cost.total.toFixed(3)}`)}`
    : title;
}

export type WorkflowDisplayStatus = WorkflowLaneItemStatus | "queued" | "done" | "failed" | "stopping" | "stopped";
export type WorkflowThemeColor = Parameters<Theme["fg"]>[0];

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1_000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  if (value < 1_000) return `${Math.trunc(n)}`;
  if (value < 1_000_000) return `${sign}${formatCompact(value / 1_000)}k`;
  return `${sign}${formatCompact(value / 1_000_000)}m`;
}

export function statusIcon(status: WorkflowDisplayStatus, theme: Theme): string {
  switch (status) {
    case "success":
    case "done":
      return theme.fg("success", "✓");
    case "warning":
      return theme.fg("warning", "!");
    case "error":
    case "failed":
      return theme.fg("error", "✗");
    case "stopped":
      return theme.fg("dim", "■");
    case "stopping":
      return theme.fg("warning", "◌");
    case "running":
      return theme.fg("accent", "●");
    case "queued":
    case "pending":
      return theme.fg("dim", "○");
  }
}

export { toDisplayLine } from "./display-text.ts";

export function truncateDisplay(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width);
}

export interface AgentDetailOptions {
  now?: number;
  includeQueuedStatus?: boolean;
  /** Compact surfaces (widget) show only the ✗ icon; detail surfaces show the message. */
  includeError?: boolean;
  errorMaxLength?: number;
}

export function agentDetailParts(agent: AgentRowSnapshot, now?: number): string[];
export function agentDetailParts(agent: AgentRowSnapshot, options?: AgentDetailOptions): string[];
export function agentDetailParts(agent: AgentRowSnapshot, optionsOrNow: AgentDetailOptions | number = {}): string[] {
  const options = typeof optionsOrNow === "number" ? { now: optionsOrNow } : optionsOrNow;
  const now = options.now ?? Date.now();
  const includeQueuedStatus = options.includeQueuedStatus ?? true;
  const includeError = options.includeError ?? true;
  const parts: string[] = [];
  if (agent.toolUses > 0) parts.push(`${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}`);
  if (agent.lastTool) parts.push(toDisplayLine(agent.lastTool, 32));
  if (agent.startedAt !== undefined) parts.push(formatDuration((agent.doneAt ?? now) - agent.startedAt));
  else if (includeQueuedStatus && agent.status === "queued") parts.push("queued");
  if (agent.status === "failed" && includeError && agent.error) {
    parts.push(toDisplayLine(agent.error, options.errorMaxLength ?? 80));
  }
  return parts;
}

export function agentLabelColor(agent: AgentRowSnapshot): WorkflowThemeColor {
  return agent.status === "running" ? "text" : "muted";
}

export interface WorkflowStatusCounts {
  readonly queued: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
}

export interface WorkflowStatusSource {
  readonly title: string;
  readonly doneAt?: number;
  readonly currentPhase: string;
  readonly counters: readonly { readonly key: string; readonly label: string; readonly value: number }[];
}

interface WorkflowInspectionSource {
  readonly name: string;
  readonly snapshot: WorkflowProgressSnapshot | (() => WorkflowProgressSnapshot);
}

export function workflowInspectionSnapshot(inspection: WorkflowInspectionSource): WorkflowProgressSnapshot {
  return typeof inspection.snapshot === "function" ? inspection.snapshot() : inspection.snapshot;
}

export function formatWorkflowInspection(inspection: WorkflowInspectionSource): string {
  const snapshot = workflowInspectionSnapshot(inspection);
  const counts = countSnapshotAgents(snapshot);
  const lines = [
    `Workflow inspector: ${formatWorkflowTitle(inspection.name)}`,
    `Run: ${snapshot.runId}`,
    `Phase: ${snapshot.currentPhase}`,
    `Agents: ${counts.running} running, ${counts.queued} queued, ${counts.done} done, ${counts.failed} failed`,
  ];
  const usage = formatWorkflowUsageLine(snapshot.usage);
  if (usage) lines.push(usage);
  if (snapshot.logs.length > 0) lines.push("Recent log:", ...snapshot.logs.slice(-8).map((entry) => `- ${entry}`));
  return lines.join("\n");
}

export function statusText(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  const counts = countSnapshotAgents(snapshot);
  return statusTextFromCounts(snapshot, counts, theme);
}

export function statusTextFromCounts(snapshot: WorkflowStatusSource, counts: WorkflowStatusCounts, theme: Theme): string | undefined {
  if (snapshot.doneAt !== undefined) return undefined;

  const complete = counts.done + counts.failed;
  const active = counts.running + counts.queued;
  const kept = snapshot.counters.find((counter) => counter.key === "kept" || counter.label.toLowerCase() === "kept");
  const displayName = formatWorkflowTitle(snapshot.title);

  const parts = [theme.fg("accent", displayName), theme.fg("muted", snapshot.currentPhase)];
  if (counts.total > 0) parts.push(theme.fg("muted", `${complete}/${counts.total}`));
  if (kept) parts.push(theme.fg("success", `${formatCount(kept.value)} kept`));
  else if (active > 0) parts.push(theme.fg("muted", `${active} active`));

  return parts.join(theme.fg("dim", " · "));
}

function countSnapshotAgents(snapshot: WorkflowProgressSnapshot): WorkflowStatusCounts {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, total: 0 };
  for (const phase of snapshot.phases) {
    for (const agent of phase.agents) {
      counts[agent.status === "stopped" ? "failed" : agent.status === "stopping" ? "running" : agent.status]++;
      counts.total++;
    }
  }
  return counts;
}

function formatCompact(value: number): string {
  if (value >= 100) return `${Math.round(value)}`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}
