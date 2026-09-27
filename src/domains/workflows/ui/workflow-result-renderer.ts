import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { isAdvisoryReport, type AdvisoryReportWithStats } from "../advisory/advisory-schema.ts";
import { renderIssueDetails, renderIssuesTable } from "../review/review-format.ts";
import { toReviewIssues } from "../review/review-issues.ts";
import { formatCount, formatWorkflowHeading, toDisplayLine } from "./workflow-format.ts";
import type { WorkflowRunState } from "../runs/workflow-run-record.ts";
import { formatWorkflowUsageLine } from "../execution/usage.ts";
import type { WorkflowPerfDetails, WorkflowResultEnvelope } from "../execution/workflow-execution.ts";
import { unknownErrorMessage } from "../../../core/errors.ts";

export function isWorkflowResult(value: unknown): value is WorkflowResultEnvelope {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && "result" in value && typeof value.completedAt === "number";
}

export interface WorkflowRunDisplayMetadata {
  readonly runId?: string;
  readonly resumedFromRunId?: string;
  readonly status?: WorkflowRunState;
}

export interface WorkflowDetailLineInput {
  readonly usage?: unknown;
  readonly perf?: WorkflowPerfDetails;
  readonly metadata?: WorkflowRunDisplayMetadata;
}

export function renderWorkflowResult(
  name: string,
  result: unknown,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): Component {
  const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(renderWorkflowResultText(name, result, expanded, theme, usage, metadata, perf), 0, 0));
  return box;
}

export function renderWorkflowResultText(
  name: string,
  result: unknown,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): string {
  if (isAdvisoryReport(result)) {
    return renderAdvisoryResult(name, result, expanded, theme, usage, metadata, perf);
  }
  return renderGenericWorkflowResult(name, result, expanded, theme, usage, metadata, perf);
}

function renderAdvisoryResult(
  name: string,
  result: AdvisoryReportWithStats,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): string {
  const incomplete = result.status === "incomplete";
  const lines = [formatWorkflowHeading(name, usage, theme), theme.fg(incomplete ? "warning" : "muted", `${incomplete ? "Incomplete" : "Finished"}: ${toDisplayLine(result.summary, 500)}`)];
  if (!expanded) return lines.join("\n");
  if (result.coverage?.length) lines.push(theme.fg("dim", result.coverage.map((stage) => `${stage.stage}: ${stage.completed}/${stage.expected} complete, ${stage.failed} failed`).join(" · ")));
  for (const gap of result.gaps ?? []) lines.push(theme.fg("warning", gap));
  const stats = statsLine(result.stats, theme);
  if (stats) lines.push(stats);
  pushWorkflowDetailLines(lines, theme, { usage, metadata, perf });

  if (result.findings.length === 0) {
    lines.push(incomplete ? theme.fg("warning", "No verified findings; coverage is incomplete.") : theme.fg("success", "No findings."));
    if (result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
    return lines.join("\n");
  }

  const issues = toReviewIssues(name, result);
  lines.push(theme.fg("dim", "Findings:"));
  lines.push(renderIssuesTable(issues, theme, { maxRows: issues.length }));
  for (const issue of issues) lines.push(renderIssueDetails(issue, theme));
  if (result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
  return lines.join("\n");
}

function renderNextSteps(nextSteps: string[], lines: string[], theme: Theme): void {
  lines.push(theme.fg("dim", "Next steps:"));
  for (const step of nextSteps) {
    lines.push(`  - ${theme.fg("muted", step)}`);
  }
}

function renderGenericWorkflowResult(
  name: string,
  result: unknown,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): string {
  const status = metadata?.status ?? "completed";
  const color = status === "failed" ? "error" : status === "paused" ? "warning" : "muted";
  const lines = [formatWorkflowHeading(name, usage, theme), theme.fg(color, formatWorkflowOutcome(result, status))];
  if (expanded) {
    pushWorkflowDetailLines(lines, theme, { usage, metadata, perf });
    lines.push(theme.fg("dim", safeJson(result)));
  }
  return lines.join("\n");
}

export function formatWorkflowOutcome(result: unknown, status: WorkflowRunState = "completed"): string {
  const labels: Record<WorkflowRunState, string> = {
    completed: "Finished", failed: "Failed", stopped: "Stopped", paused: "Paused", running: "Running", queued: "Queued",
  };
  let summary = toDisplayLine(extractSummary(result) ?? "Open the expanded view for details.", 500);
  // Also clean up summaries retained by older versions.
  summary = summary.replace(/^(?:Workflow (?:completed|finished|failed|stopped|paused):\s*)+/i, "");
  if (status === "stopped" && /^(?:Workflow |Agent .+ )?stopped by user\.?$/i.test(summary)) {
    summary = "Cancelled at your request.";
  }
  return `${labels[status]}: ${summary}`;
}

function pushWorkflowDetailLines(lines: string[], theme: Theme, input: WorkflowDetailLineInput): void {
  for (const line of formatWorkflowDetailLines(input)) {
    lines.push(theme.fg("dim", line));
  }
}

export function formatWorkflowDetailLines(input: WorkflowDetailLineInput): string[] {
  return [
    formatWorkflowRunLine(input.metadata),
    formatWorkflowUsageLine(input.usage),
    formatWorkflowPerfLine(input.perf),
  ].filter((line): line is string => line !== undefined);
}

export function formatWorkflowRunLine(metadata: WorkflowRunDisplayMetadata | undefined): string | undefined {
  if (!metadata?.runId) return undefined;
  return metadata.resumedFromRunId ? `Run: ${metadata.runId} (resumed from ${metadata.resumedFromRunId})` : `Run: ${metadata.runId}`;
}

export function formatWorkflowPerfLine(perf: WorkflowPerfDetails | undefined): string | undefined {
  if (!perf) return undefined;
  const parts = perf.aggregates.slice(0, 4).map((aggregate) => `${aggregate.name} ${Math.round(aggregate.total)}ms`);
  return parts.length > 0 ? `Perf: ${parts.join(" · ")}` : "Perf: no samples";
}

function statsLine(stats: Record<string, string | number> | undefined, theme: Theme): string | undefined {
  if (!stats) return undefined;
  const ordered = ["files", "candidates", "dropped", "verified", "kept"];
  const parts = ordered.flatMap((key) => {
    const value = stats[key];
    if (value === undefined) return [];
    return [`${key} ${typeof value === "number" ? formatCount(value) : value}`];
  });
  if (parts.length === 0) return undefined;
  return theme.fg("dim", parts.join(" · "));
}

function extractSummary(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.summary === "string") return value.summary;
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return unknownErrorMessage(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
