export function workflowDebug(message: string): void {
  if (process.env.PI_WORKFLOW_DEBUG === "1") process.stderr.write(`[workflow] ${message}\n`);
}
