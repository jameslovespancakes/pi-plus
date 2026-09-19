import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentPath } from "../../core/store.ts";
import { env, setEnv } from "../../core/env.ts";
import { runSshCommand, shQuote } from "../../core/exec/process.ts";
import { readRemote } from "../remote/config-path.ts";

/**
 * `/board setup | restart | clear`
 *
 * Two deployment shapes:
 *   local   pi owns the lifecycle and starts the server on session start
 *   remote  a native service (launchd / systemd / Task Scheduler) owns it, so
 *           it returns by itself when the host reboots
 *
 * An externally managed board is also supported: supply a URL and token and
 * pi-plus will only ever connect to it.
 */

const PID_FILE = "board-server.pid";
const LOG_FILE = "board-server.log";
const DEFAULT_PORT = 8787;

function serverEntry(): string {
  // src/domains/agents/ -> repo root -> server/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "server", "board-server.mjs");
}

type Mode = "local" | "remote" | "external";

function mode(): Mode {
  const value = env("AGENT_BOARD_MODE");
  return value === "local" || value === "remote" ? value : "external";
}

function boardUrl(): string | undefined {
  return env("AGENT_BOARD_URL");
}

function httpBase(): string | undefined {
  const url = boardUrl();
  if (!url) return undefined;
  return url.replace(/^ws(s)?:/, "http$1:").replace(/\/ws\/?$/, "");
}

/* ---------------------------------- local --------------------------------- */

function pidPath(): string {
  return agentPath(PID_FILE);
}

function readPid(): number | undefined {
  try {
    const pid = Number(readFileSync(pidPath(), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

function stopLocal(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch { /* already gone */ }
  try {
    rmSync(pidPath());
  } catch { /* nothing to remove */ }
  return true;
}

/** Starts a detached server and records its pid. Safe to call when running. */
export function startLocal(): { started: boolean; reason?: string } {
  if (mode() !== "local") return { started: false, reason: "not a local board" };
  if (readPid()) return { started: false, reason: "already running" };

  const entry = serverEntry();
  if (!existsSync(entry)) return { started: false, reason: `server not found at ${entry}` };

  const token = env("AGENT_BOARD_TOKEN");
  if (!token) return { started: false, reason: "AGENT_BOARD_TOKEN is not set" };

  const port = new URL(boardUrl() ?? `ws://127.0.0.1:${DEFAULT_PORT}/ws`).port || String(DEFAULT_PORT);
  mkdirSync(agentPath("board-data"), { recursive: true });

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_BOARD_TOKEN: token,
      AGENT_BOARD_PORT: port,
      AGENT_BOARD_HOST: "127.0.0.1",
      AGENT_BOARD_DB: join(agentPath("board-data"), "board.sqlite"),
    },
  });

  if (!child.pid) return { started: false, reason: "spawn failed" };
  writeFileSync(pidPath(), String(child.pid), "utf8");
  child.unref();
  return { started: true };
}

/* --------------------------------- remote --------------------------------- */

/** Install script per platform. Each makes the board restart at boot. */
function installScript(platform: string, token: string, port: string): string {
  const common = `set -e
mkdir -p ~/.pi-board
cat > ~/.pi-board/board-server.mjs <<'PI_PLUS_BOARD_EOF'
__SERVER__
PI_PLUS_BOARD_EOF
cd ~/.pi-board
if [ ! -d node_modules/ws ]; then npm install ws@^8 --no-audit --no-fund --silent; fi
`;

  if (platform === "darwin") {
    return `${common}
cat > ~/Library/LaunchAgents/com.pi-plus.board.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pi-plus.board</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string><string>$HOME/.pi-board/board-server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME/.pi-board</string>
  <key>EnvironmentVariables</key><dict>
    <key>AGENT_BOARD_TOKEN</key><string>${token}</string>
    <key>AGENT_BOARD_PORT</key><string>${port}</string>
    <key>AGENT_BOARD_DB</key><string>$HOME/.pi-board/board.sqlite</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.pi-board/board.log</string>
  <key>StandardErrorPath</key><string>$HOME/.pi-board/board.error.log</string>
</dict></plist>
EOF
launchctl unload ~/Library/LaunchAgents/com.pi-plus.board.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.pi-plus.board.plist
echo INSTALLED=launchd`;
  }

  return `${common}
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pi-plus-board.service <<EOF
[Unit]
Description=pi-plus agent board
After=network.target

[Service]
ExecStart=$(command -v node) %h/.pi-board/board-server.mjs
WorkingDirectory=%h/.pi-board
Environment=AGENT_BOARD_TOKEN=${token}
Environment=AGENT_BOARD_PORT=${port}
Environment=AGENT_BOARD_DB=%h/.pi-board/board.sqlite
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now pi-plus-board.service
# Survive logout so the board returns after a reboot.
loginctl enable-linger "$USER" 2>/dev/null || true
echo INSTALLED=systemd`;
}

async function detectPlatform(host: string): Promise<string> {
  const result = await runSshCommand(host, "uname -s", { timeoutSeconds: 15 });
  const name = result.stdout.trim().toLowerCase();
  return name.includes("darwin") ? "darwin" : "linux";
}

async function installRemote(ctx: any, host: string, token: string, port: string): Promise<boolean> {
  const entry = serverEntry();
  if (!existsSync(entry)) {
    ctx.ui.notify(`Server source missing at ${entry}`, "error");
    return false;
  }

  ctx.ui.notify(`Detecting platform on ${host}…`, "info");
  const platform = await detectPlatform(host);
  const source = readFileSync(entry, "utf8");
  const script = installScript(platform, token, port).replace("__SERVER__", source);

  ctx.ui.notify(`Installing board on ${host} (${platform})…`, "info");
  const result = await runSshCommand(host, "bash -s", { input: script, timeoutSeconds: 180 });
  if (result.code !== 0) {
    ctx.ui.notify(`Install failed:\n${result.stderr.trim() || result.stdout.trim()}`, "error");
    return false;
  }
  ctx.ui.notify(`Installed (${result.stdout.match(/INSTALLED=(\w+)/)?.[1] ?? "ok"}). It will restart automatically on reboot.`, "info");
  return true;
}

async function restartRemote(host: string): Promise<string> {
  const platform = await detectPlatform(host);
  const command = platform === "darwin"
    ? "launchctl kickstart -k gui/$(id -u)/com.pi-plus.board && echo restarted"
    : "systemctl --user restart pi-plus-board.service && echo restarted";
  const result = await runSshCommand(host, command, { timeoutSeconds: 60 });
  return result.code === 0 ? "restarted" : (result.stderr.trim() || `exit ${result.code}`);
}

/* ---------------------------------- probes -------------------------------- */

async function health(): Promise<{ ok: boolean; detail: string }> {
  const base = httpBase();
  if (!base) return { ok: false, detail: "no board URL configured" };
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = await response.json() as { activeAgents?: number };
    return { ok: true, detail: `${body.activeAgents ?? 0} agent(s) connected` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function clearBoard(all: boolean): Promise<string> {
  const base = httpBase();
  const token = env("AGENT_BOARD_TOKEN");
  if (!base || !token) return "no board configured";
  const response = await fetch(`${base}${all ? "/clear-all" : "/clear"}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return `HTTP ${response.status}`;
  const body = await response.json() as { cleared?: number };
  return `cleared ${body.cleared ?? 0} message(s)`;
}

/* --------------------------------- command -------------------------------- */

async function setup(pi: ExtensionAPI, ctx: any): Promise<void> {
  const choice = await ctx.ui.select("Agent board setup", [
    "Run locally          (pi starts it each session)",
    "Install on a server  (restarts itself on reboot)",
    "Connect to existing  (URL + token)",
  ]);
  if (!choice) return;

  if (choice.startsWith("Connect")) {
    const url = await ctx.ui.input("Board URL", "ws://host:8787/ws");
    if (!url) return;
    const token = await ctx.ui.input("Board token", "shared secret");
    if (!token) return;
    setEnv("AGENT_BOARD_URL", url.trim());
    setEnv("AGENT_BOARD_TOKEN", token.trim());
    setEnv("AGENT_BOARD_MODE", "external");
    const probe = await health();
    ctx.ui.notify(probe.ok ? `Connected — ${probe.detail}. Restart pi to join.` : `Saved, but not reachable: ${probe.detail}`, probe.ok ? "info" : "warning");
    return;
  }

  // Both remaining paths need a token; reuse the existing one so already
  // connected agents are not locked out.
  let token = env("AGENT_BOARD_TOKEN");
  if (!token) {
    token = randomBytes(32).toString("base64url");
    setEnv("AGENT_BOARD_TOKEN", token);
  }

  if (choice.startsWith("Run locally")) {
    const port = (await ctx.ui.input("Port", String(DEFAULT_PORT)))?.trim() || String(DEFAULT_PORT);
    setEnv("AGENT_BOARD_URL", `ws://127.0.0.1:${port}/ws`);
    setEnv("AGENT_BOARD_MODE", "local");
    stopLocal();
    const started = startLocal();
    if (!started.started) {
      ctx.ui.notify(`Could not start: ${started.reason}`, "error");
      return;
    }
    await new Promise((done) => setTimeout(done, 800));
    const probe = await health();
    ctx.ui.notify(
      probe.ok
        ? `Local board running on port ${port}. pi will start it automatically each session.`
        : `Started, but health check failed: ${probe.detail}`,
      probe.ok ? "info" : "warning",
    );
    return;
  }

  // Remote: offer configured workers first, then free-form.
  const workers = readRemote().workers.filter((worker) => worker.enabled !== false);
  const options = [...workers.map((worker) => `${worker.name}  (${worker.ssh})`), "Other host…"];
  const picked = await ctx.ui.select("Install on which host?", options);
  if (!picked) return;

  let host: string;
  if (picked === "Other host…") {
    const entered = await ctx.ui.input("SSH host", "user@host");
    if (!entered) return;
    host = entered.trim();
  } else {
    host = workers[options.indexOf(picked)].ssh;
  }

  const port = (await ctx.ui.input("Port", String(DEFAULT_PORT)))?.trim() || String(DEFAULT_PORT);
  if (!(await installRemote(ctx, host, token, port))) return;

  const hostname = host.includes("@") ? host.split("@")[1] : host;
  setEnv("AGENT_BOARD_URL", `ws://${hostname}:${port}/ws`);
  setEnv("AGENT_BOARD_MODE", "remote");
  setEnv("AGENT_BOARD_SSH", host);

  await new Promise((done) => setTimeout(done, 1_500));
  const probe = await health();
  ctx.ui.notify(
    probe.ok ? `Board reachable — ${probe.detail}. Restart pi to join.` : `Installed, but not reachable yet: ${probe.detail}`,
    probe.ok ? "info" : "warning",
  );
}

/** Wires the session hook that keeps a local board alive. */
export function registerBoardLifecycle(pi: ExtensionAPI): void {
  // A local board is pi's responsibility: bring it up with the session.
  pi.on("session_start", async () => {
    if (mode() === "local") startLocal();
  });
}

/** Admin verbs for `/board`. Returns false when `args` is not one of them. */
export async function handleBoardAdmin(pi: ExtensionAPI, ctx: any, args: string): Promise<boolean> {
  {
    {
      const [action, flag] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!["setup", "restart", "clear", "status"].includes(action ?? "")) return false;

      if (action === "setup") {
        if (!ctx.hasUI) ctx.ui.notify("/board setup requires an interactive session.", "error");
        else await setup(pi, ctx);
        return true;
      }

      if (action === "restart") {
        const current = mode();
        if (current === "local") {
          stopLocal();
          const started = startLocal();
          await new Promise((done) => setTimeout(done, 800));
          const probe = await health();
          ctx.ui.notify(
            started.started && probe.ok ? `Local board restarted — ${probe.detail}.` : `Restart issue: ${started.reason ?? probe.detail}`,
            started.started && probe.ok ? "info" : "warning",
          );
          return true;
        }
        if (current === "remote") {
          const host = env("AGENT_BOARD_SSH");
          if (!host) {
            ctx.ui.notify("No SSH host recorded for the remote board. Run /board setup again.", "error");
            return true;
          }
          ctx.ui.notify(`Restarting board on ${host}…`, "info");
          const detail = await restartRemote(host);
          const probe = await health();
          ctx.ui.notify(`${detail}${probe.ok ? ` — ${probe.detail}` : ""}`, probe.ok ? "info" : "warning");
          return true;
        }
        ctx.ui.notify("This board is externally managed; restart it where it runs.", "warning");
        return true;
      }

      if (action === "clear") {
        const all = flag === "all";
        const ok = await ctx.ui.confirm(
          all ? "Clear everything?" : "Clear the board?",
          all
            ? "Deletes all messages, threads, coordinator links and presence history."
            : "Deletes all messages and threads. Coordinator links are kept.",
        );
        if (!ok) return true;
        try {
          ctx.ui.notify(await clearBoard(all), "info");
        } catch (error) {
          ctx.ui.notify(`Clear failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return true;
      }

      // /board status
      const probe = await health();
      ctx.ui.notify(
        [
          `mode:   ${mode()}`,
          `url:    ${boardUrl() ?? "not configured"}`,
          mode() === "local" ? `pid:    ${readPid() ?? "not running"}` : "",
          `health: ${probe.ok ? probe.detail : probe.detail}`,
          "",
          "/board setup · /board restart · /board clear [all]",
        ].filter(Boolean).join("\n"),
        probe.ok ? "info" : "warning",
      );
      return true;
    }
  }
}
