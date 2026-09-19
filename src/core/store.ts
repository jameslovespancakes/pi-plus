import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Shared JSON storage with atomic writes. */

export function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function agentPath(...parts: string[]): string {
  return join(agentDir(), ...parts);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Best-effort atomic write. */
export function writeJson(path: string, value: unknown, pretty = false, mode?: number): boolean {
  const temp = `${path}.${process.pid}.tmp`;
  const content = JSON.stringify(value, undefined, pretty ? 2 : undefined);
  const options = { encoding: "utf8" as const, ...(mode === undefined ? {} : { mode }) };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, content, options);
    renameSync(temp, path);
    return true;
  } catch {
    try {
      writeFileSync(path, content, options);
      return true;
    } catch {
      return false;
    } finally {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }
}
