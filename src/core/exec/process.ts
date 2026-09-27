import { runBoundedProcess } from "./bounded-process.ts";

/** SSH policy and the tail-capturing view of the shared process runner. */
export const SSH_ARGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
const PROCESS_TAIL_CHARS = 2 * 1024 * 1024;

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  totalOutputBytes: number;
}

export interface RunOptions {
  cwd?: string;
  input?: string | Buffer | { file: string };
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onData?: (chunk: string) => void;
}

export function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > PROCESS_TAIL_CHARS ? next.slice(-PROCESS_TAIL_CHARS) : next;
}

export async function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  const result = await runBoundedProcess({
    file: command, args, cwd: options.cwd ?? process.cwd(), stdin: options.input,
    signal: options.signal,
    timeoutMs: options.timeoutSeconds ? options.timeoutSeconds * 1_000 : undefined,
    tailChars: PROCESS_TAIL_CHARS, onData: options.onData,
    abortError: "Process aborted", timeoutError: "Process timed out",
    exitError: (stderr, code) => stderr || `Process exited with code ${code ?? 1}`,
  });
  if (result.failure?.kind === "spawn" || result.failure?.kind === "input") throw new Error(result.failure.message);
  return {
    code: result.ok ? 0 : result.failure.kind === "exit" ? result.failure.code ?? 1 : 1,
    stdout: result.stdout, stderr: result.stderr,
    timedOut: result.failure?.kind === "timeout", aborted: result.failure?.kind === "abort",
    totalOutputBytes: result.bytes,
  };
}

export async function runLocal(command: string, args: string[], cwd?: string): Promise<ProcessResult> {
  return runProcess(command, args, { cwd, timeoutSeconds: 60 });
}

export async function runSshCommand(
  host: string,
  remoteCommand: string,
  options: RunOptions = {},
  extraArgs: string[] = [],
): Promise<ProcessResult> {
  return runProcess("ssh", [...SSH_ARGS, ...extraArgs, host, remoteCommand], options);
}

/** POSIX single-quote escaping for values interpolated into remote scripts. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function rootAssignment(root: string): string {
  if (root.startsWith("~/")) return `ROOT="$HOME"/${shQuote(root.slice(2))}`;
  return `ROOT=${shQuote(root)}`;
}
