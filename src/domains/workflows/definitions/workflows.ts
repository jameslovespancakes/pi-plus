import { fileURLToPath } from "node:url";
import * as codeReview from "../builtins/code-review.ts";
import * as refactorScout from "../builtins/refactor-scout.ts";
import * as diagnose from "../builtins/diagnose.ts";
import * as perfReview from "../builtins/perf-review.ts";
import * as research from "../builtins/research.ts";
import type { WorkflowModule } from "../types.ts";

/**
 * Static imports share pi's bundled typebox instance. Add guaranteed workflows
 * here; discovery.ts handles optional drop-ins.
 */
// Built-ins depend on shared provider/process/storage code too. Moving those
// helpers out of workflows must not make replay blind to their future changes.
export const BUILTIN_SOURCE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface BuiltinWorkflowDefinition {
  readonly module: WorkflowModule;
  readonly filename: string;
  readonly path: string;
  readonly root: string;
}

export const BUILTIN_WORKFLOW_DEFINITIONS: readonly BuiltinWorkflowDefinition[] = [
  defineBuiltinWorkflow(codeReview, "code-review.ts"),
  defineBuiltinWorkflow(refactorScout, "refactor-scout.ts"),
  defineBuiltinWorkflow(diagnose, "diagnose.ts"),
  defineBuiltinWorkflow(perfReview, "perf-review.ts"),
  defineBuiltinWorkflow(research, "research.ts"),
];
export const BUILTIN_WORKFLOWS = BUILTIN_WORKFLOW_DEFINITIONS.map(({ module }) => module);
export const BUILTIN_WORKFLOW_FILES = new Set(BUILTIN_WORKFLOW_DEFINITIONS.map(({ filename }) => filename));
export const BUILTIN_WORKFLOW_NAMES = BUILTIN_WORKFLOWS.map((mod) => mod.meta.name);

function defineBuiltinWorkflow(module: WorkflowModule, filename: string): BuiltinWorkflowDefinition {
  return {
    module: { meta: module.meta, default: module.default },
    filename,
    path: fileURLToPath(new URL(`../builtins/${filename}`, import.meta.url)),
    root: BUILTIN_SOURCE_ROOT,
  };
}
