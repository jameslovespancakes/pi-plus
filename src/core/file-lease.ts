import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Non-blocking cross-process lease. Never delete a live or partially written lock. */
export function acquireFileLease(path: string, ttlMs: number, now = Date.now()): { release(): void } | undefined {
  mkdirSync(dirname(path), { recursive: true });
  const owner = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ owner, expiresAt: now + ttlMs }), "utf8"); }
      finally { closeSync(fd); }
      return { release() {
        try {
          if (JSON.parse(readFileSync(path, "utf8")).owner === owner) rmSync(path, { force: true });
        } catch { /* already removed */ }
      } };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        let expiresAt: number;
        try { expiresAt = Number(JSON.parse(readFileSync(path, "utf8")).expiresAt); }
        catch { expiresAt = NaN; }
        if (!Number.isFinite(expiresAt)) expiresAt = statSync(path).mtimeMs + ttlMs;
        if (expiresAt > now) return undefined;
        rmSync(path, { force: true });
      } catch { return undefined; }
    }
  }
  return undefined;
}
