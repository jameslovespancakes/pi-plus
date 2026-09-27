import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../../core/env.ts";
import { type Config } from "./types.ts";

function configDir(): string { return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"); }

export function loadConfig(): Config | undefined {
  // Unified store first; the standalone agent-board.json is still honoured.
  const url = env("AGENT_BOARD_URL");
  const token = env("AGENT_BOARD_TOKEN");
  if (url && token) return { url, token, adminName: env("AGENT_BOARD_NAME") };
  try {
    const value = JSON.parse(fs.readFileSync(path.join(configDir(), "agent-board.json"), "utf8"));
    if (typeof value.url === "string" && typeof value.token === "string") return value;
  } catch {}
  return undefined;
}
