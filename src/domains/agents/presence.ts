import { spawnSync } from "node:child_process";
import { type GitInfo } from "./types.ts";

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function normalizeRemote(remote?: string): string | undefined {
  if (!remote) return undefined;
  return remote.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").toLowerCase();
}

export function readGit(cwd: string): GitInfo {
  const meta = git(cwd, ["show", "-s", "--format=%H%n%ct%n%s", "HEAD"])?.split("\n") ?? [];
  return {
    branch: git(cwd, ["branch", "--show-current"]),
    repo: normalizeRemote(git(cwd, ["remote", "get-url", "origin"])) ?? git(cwd, ["rev-parse", "--show-toplevel"]),
    commit: meta[0],
    commitTime: meta[1] ? Number(meta[1]) * 1_000 : undefined,
    commitSubject: meta[2],
    dirty: Boolean(git(cwd, ["status", "--porcelain"])),
  };
}
