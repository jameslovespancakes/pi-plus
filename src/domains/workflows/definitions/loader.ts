import { fileURLToPath } from "node:url";
import { type AutocompleteItem } from "@earendil-works/pi-tui";
import type { LoadedWorkflow, WorkflowRef } from "../types.ts";
import type { PerfSink } from "../execution/perf.ts";
import { type ResolvedWorkflowRunOptions } from "./options.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./command-completions.ts";

/** Root used for bundled and project workflow discovery. */
export const EXTENSION_DIR = fileURLToPath(new URL("..", import.meta.url));

type DiscoveryModule = typeof import("./discovery.ts");

type EngineModule = typeof import("../execution/engine.ts");

type InlineWorkflowModule = typeof import("./inline-workflow.ts");

export async function loadDiscovery(): Promise<DiscoveryModule> {
  return await import("./discovery.ts");
}

export async function loadEngine(): Promise<EngineModule> {
  return await import("../execution/engine.ts");
}

export async function loadInlineWorkflow(): Promise<InlineWorkflowModule> {
  return await import("./inline-workflow.ts");
}

export async function createInvocationPerf(options: ResolvedWorkflowRunOptions): Promise<PerfSink | undefined> {
  if (!options.perf) return undefined;
  const { createPerfRecorder } = await import("../execution/perf.ts");
  return createPerfRecorder(true);
}

/**
 * Resolve an `api.workflow()` reference to a registered workflow module. Throws on an unknown name.
 */
export async function resolveWorkflowRef(ref: WorkflowRef, perf?: PerfSink): Promise<LoadedWorkflow> {
  const { discoverWorkflows } = await loadDiscovery();
  const workflows = await discoverWorkflows(EXTENSION_DIR, { perf });
  const mod = workflows.get(ref);
  if (!mod) {
    const available = [...workflows.keys()].join(", ") || "(none)";
    throw new Error(`Unknown workflow "${ref}". Available: ${available}`);
  }
  return mod;
}

const WORKFLOW_OPTION_COMPLETIONS = [
  { value: "--refresh", description: "Refresh dynamic workflow discovery" },
  { value: "--perf", description: "Collect workflow performance metrics" },
  { value: "--result-viewer", description: "Open supported result viewers" },
  { value: "--no-result-viewer", description: "Skip supported result viewers" },
  { value: "--resume-edited", description: "Allow resume after workflow source edits" },
  { value: "--concurrency=", description: "Optionally cap concurrent subagents" },
  { value: "--parallel-limit=", description: "Set the parallel submission limit" },
  { value: "--max-agents=", description: "Set the maximum admitted live agents" },
  { value: "--agent-timeout-ms=", description: "Set the timeout for each agent attempt" },
  { value: "--budget=", description: "Set the workflow output-token budget" },
  { value: "--resume=", description: "Resume from a retained workflow run ID" },
] as const;

export async function workflowArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
  const parts = splitArgumentPrefix(argumentPrefix);
  if (parts.completed.length === 0) {
    const { discoverWorkflows } = await loadDiscovery();
    const workflows = await discoverWorkflows(EXTENSION_DIR);
    return completeCurrentArgument(
      argumentPrefix,
      [...workflows.values()].map((workflow) => ({
        value: workflow.meta.name,
        description: workflow.meta.description,
      })),
    );
  }
  return completeCurrentArgument(argumentPrefix, WORKFLOW_OPTION_COMPLETIONS);
}
