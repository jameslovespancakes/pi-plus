import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowProgressSource } from "../types.ts";
import type { WorkflowProgressSnapshot } from "./progress-types.ts";
import { sessionKey } from "./session-identity.ts";

export interface ActiveWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
  readonly source: WorkflowProgressSource;
  readonly snapshot: () => WorkflowProgressSnapshot;
}

const sessionsByExtension = new WeakMap<ExtensionAPI, Map<string, Map<string, ActiveWorkflowInspection>>>();

function sessionRuns(pi: ExtensionAPI, ctx: ExtensionContext): Map<string, ActiveWorkflowInspection> {
  const sessions = sessionsByExtension.get(pi) ?? new Map<string, Map<string, ActiveWorkflowInspection>>();
  const key = sessionKey(ctx);
  const runs = sessions.get(key) ?? new Map<string, ActiveWorkflowInspection>();
  sessions.set(key, runs);
  sessionsByExtension.set(pi, sessions);
  return runs;
}

/** Both tool management and UI inspection query these same bindings. */
export function liveRuns(pi: ExtensionAPI, ctx: ExtensionContext): ReadonlyMap<string, ActiveWorkflowInspection> {
  return sessionRuns(pi, ctx);
}

/** Capture the originating session once; late callbacks cannot attach to a replacement session. */
export function bindLiveRun(pi: ExtensionAPI, ctx: ExtensionContext, name: string, args: string): (source: WorkflowProgressSource | undefined) => void {
  const runs = sessionRuns(pi, ctx);
  let id: string | undefined;
  return (source) => {
    if (id !== undefined) runs.delete(id);
    id = source?.snapshot().runId;
    if (source && id !== undefined) {
      runs.set(id, { name, args, startedAt: Date.now(), source, snapshot: () => source.snapshot() });
    }
  };
}

export function disposeLiveRuns(pi: ExtensionAPI, ctx: ExtensionContext): void {
  sessionsByExtension.get(pi)?.delete(sessionKey(ctx));
}
