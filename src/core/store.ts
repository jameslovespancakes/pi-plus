import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Small JSON config helper shared by every domain.
 *
 * Writes go through a temp file + rename so a crash mid-write cannot leave a
 * truncated config behind; several of these files hold auth state.
 */

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

/** Best-effort atomic write. Returns false instead of throwing. */
export function writeJson(path: string, value: unknown, pretty = false): boolean {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, undefined, pretty ? 2 : undefined), "utf8");
    renameSync(temp, path);
    return true;
  } catch {
    try {
      writeFileSync(path, JSON.stringify(value, undefined, pretty ? 2 : undefined), "utf8");
      return true;
    } catch {
      return false;
    }
  }
}
