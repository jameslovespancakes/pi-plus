import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface AtomicWriteOptions { mode?: number }
interface AtomicSyncWriteOptions extends AtomicWriteOptions {
  renameRetries?: number;
  /** Telemetry stores may drop an update after bounded rename retries. Durable records must throw. */
  dropAfterRetries?: boolean;
}

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const SPIN = new Int32Array(new SharedArrayBuffer(4));
const temporaryPath = (path: string) => `${path}.${process.pid}.${randomUUID()}.tmp`;

/** Atomic replacement only; no fallback ever writes over a live destination. */
export function writeAtomicTextSync(path: string, text: string, options: AtomicSyncWriteOptions = {}): boolean {
  const temp = temporaryPath(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, text, { encoding: "utf8", ...(options.mode !== undefined && { mode: options.mode }) });
    const retries = options.renameRetries ?? 0;
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, path);
        return true;
      } catch (error: any) {
        if (attempt >= retries) {
          if (options.dropAfterRetries) return false;
          throw error;
        }
        if (!TRANSIENT_RENAME_ERRORS.has(error?.code)) throw error;
        Atomics.wait(SPIN, 0, 0, 2 ** attempt);
      }
    }
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* Preserve the original error. */ }
  }
}

export async function writeAtomicText(path: string, text: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temp = temporaryPath(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, text, { encoding: "utf8", ...(options.mode !== undefined && { mode: options.mode }) });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
