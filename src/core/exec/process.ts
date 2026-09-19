import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

/**
 * Process and SSH execution primitives.
 *
 * Extracted from the remote-jobs extension so anything needing a bounded child
 * process gets the same timeout, abort and output-cap behaviour.
 */

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

/** Keeps only the trailing window of a stream so long builds cannot exhaust memory. */
export function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > PROCESS_TAIL_CHARS ? next.slice(-PROCESS_TAIL_CHARS) : next;
}

export function runProcess(command: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let totalOutputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process already exited.
      }
    };

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      totalOutputBytes += data.length;
      stdout = appendTail(stdout, text);
      options.onData?.(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      totalOutputBytes += data.length;
      stderr = appendTail(stderr, text);
      options.onData?.(text);
    });

    child.on("error", finishReject);

    if (options.timeoutSeconds) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutSeconds * 1000);
    }

    const onAbort = () => {
      aborted = true;
      kill();
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (typeof options.input === "string" || Buffer.isBuffer(options.input)) {
      child.stdin?.end(options.input);
    } else if (options.input?.file && child.stdin) {
      const target = child.stdin;
      const stream = createReadStream(options.input.file);
      stream.on("error", (error) => {
        kill();
        finishReject(error);
      });
      stream.pipe(target);
    }

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut, aborted, totalOutputBytes });
    });
  });
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
