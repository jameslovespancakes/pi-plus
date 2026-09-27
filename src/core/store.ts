import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomicTextSync } from "./storage/atomic.ts";

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

/** Best-effort cache/config write. Retains the legacy direct-write fallback; strict callers use storage/atomic.ts directly. */
export function writeJson(path: string, value: unknown, pretty = false, mode?: number): boolean {
  const content = JSON.stringify(value, undefined, pretty ? 2 : undefined);
  const options = { encoding: "utf8" as const, ...(mode === undefined ? {} : { mode }) };

  try {
    writeAtomicTextSync(path, content, { mode });
    return true;
  } catch {
    try {
      writeFileSync(path, content, options);
      return true;
    } catch {
      return false;
    }
  }
}
