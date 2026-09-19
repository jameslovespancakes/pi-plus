import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentPath } from "../../core/store.ts";
import { runProcess, runSshCommand } from "../../core/exec/process.ts";
import { parseTarget, readSshHosts, type SshHost } from "../../core/exec/ssh-config.ts";
import { readRemote, writeRemoteWorkers, type RemoteWorkerRecord } from "./config-path.ts";

/**
 * `/remote` — the management surface for remote test workers.
 *
 *   /remote setup    hub: toggle, add, rename, remove (bare /remote is the same)
 *   /remote add      jump straight to the add wizard
 *   /remote remove   jump straight to removal
 *
 * Hosts are merged from ~/.ssh/config and the `remote` section of pi-plus.json.
 *
 * Privacy: host aliases routinely name internal infrastructure. Everything here
 * stays in the UI layer and is never returned from a tool, so the list is not
 * sent to a model provider.
 */

const KEY_DIR = "remote-keys";

type StoredWorker = RemoteWorkerRecord;

function loadWorkers(): { workers: StoredWorker[] } {
  return { workers: readRemote().workers };
}

function saveWorkers(file: { workers: StoredWorker[] }): boolean {
  return writeRemoteWorkers(file.workers);
}

interface Row {
  name: string;
  ssh: string;
  enabled: boolean;
  origin: "ssh config" | "pi-plus" | "both";
  detail: string;
  stored?: StoredWorker;
  sshHost?: SshHost;
}

function buildRows(): Row[] {
  const stored = loadWorkers().workers;
  const storedByName = new Map(stored.map((worker) => [worker.name, worker]));
  const claimedSsh = new Set(stored.map((worker) => worker.ssh));
  const rows: Row[] = [];

  let hosts: SshHost[] = [];
  try {
    hosts = readSshHosts();
  } catch { /* no ssh config is fine */ }

  for (const host of hosts) {
    const existing = storedByName.get(host.alias);
    // A renamed worker still points at this alias; don't list it twice.
    if (!existing && claimedSsh.has(host.alias)) continue;
    const target = host.user && host.hostName ? `${host.user}@${host.hostName}` : host.hostName ?? host.alias;
    rows.push({
      name: host.alias,
      ssh: existing?.ssh ?? host.alias,
      enabled: existing ? existing.enabled !== false : false,
      origin: existing ? "both" : "ssh config",
      detail: target + (host.port ? `:${host.port}` : ""),
      stored: existing,
      sshHost: host,
    });
  }

  for (const worker of stored) {
    if (rows.some((row) => row.name === worker.name)) continue;
    rows.push({
      name: worker.name,
      ssh: worker.ssh,
      enabled: worker.enabled !== false,
      origin: "pi-plus",
      detail: worker.ssh + (worker.port ? `:${worker.port}` : ""),
      stored: worker,
    });
  }

  return rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

function renderRow(row: Row, width: number): string {
  return `[${row.enabled ? "✓" : " "}] ${row.name.padEnd(width)}  ${row.detail.padEnd(28)}  ${row.origin}`;
}

function setEnabled(row: Row, enabled: boolean): void {
  const file = loadWorkers();
  const existing = file.workers.find((worker) => worker.name === row.name);
  if (existing) {
    existing.enabled = enabled;
  } else {
    file.workers.push({
      name: row.name,
      ssh: row.ssh,
      root: "~/remote_tests",
      nice: 10,
      tags: [],
      enabled,
      ...(row.sshHost?.port ? { port: row.sshHost.port } : {}),
    });
  }
  saveWorkers(file);
}

/** Valid worker names keep the remote directory layout predictable. */
function validateName(name: string, taken: string[]): string | undefined {
  if (!name) return "Name cannot be empty.";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Use letters, numbers, dot, dash or underscore only.";
  if (name.length > 64) return "Name is too long.";
  if (taken.includes(name)) return `“${name}” is already used.`;
  return undefined;
}

async function probe(ssh: string, extraArgs: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await runSshCommand(
      ssh,
      "command -v tar >/dev/null && command -v bash >/dev/null && uname -s",
      { timeoutSeconds: 15 },
      extraArgs,
    );
    if (result.code === 0) return { ok: true, detail: result.stdout.trim() || "ok" };
    return { ok: false, detail: result.stderr.trim().split("\n")[0] || `exit ${result.code}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function keyPath(label: string): string {
  return join(agentPath(KEY_DIR), `pi-plus_${label.replace(/[^A-Za-z0-9._-]/g, "_")}`);
}

/** Generates a dedicated ed25519 key. The private half never leaves disk. */
async function generateKey(label: string): Promise<{ path: string; publicKey: string }> {
  mkdirSync(agentPath(KEY_DIR), { recursive: true });
  const path = keyPath(label);

  const result = await runProcess(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", `pi-plus@${label}`, "-f", path],
    { timeoutSeconds: 30 },
  );
  if (result.code !== 0 && !result.stderr.includes("already exists")) {
    throw new Error(result.stderr.trim() || `ssh-keygen exited ${result.code}`);
  }

  try {
    chmodSync(path, 0o600);
  } catch { /* best effort on Windows */ }

  return { path, publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
}

function addWorker(name: string, ssh: string, extras: Partial<StoredWorker>): void {
  const file = loadWorkers();
  const entry: StoredWorker = { name, ssh, root: "~/remote_tests", nice: 10, tags: [], enabled: true, ...extras };
  const index = file.workers.findIndex((worker) => worker.name === name);
  if (index >= 0) file.workers[index] = entry;
  else file.workers.push(entry);
  saveWorkers(file);
}

async function addServer(ctx: any): Promise<void> {
  const route = await ctx.ui.select("Add a server", [
    "I can already SSH to it       (fastest)",
    "I have a private key file     (point at the path)",
    "I have nothing yet            (generate a key)",
  ]);
  if (!route) return;

  const raw = await ctx.ui.input("Host", "gpu-box  or  deploy@203.0.113.9:22");
  if (!raw) return;
  const target = parseTarget(raw);
  if (!target) {
    ctx.ui.notify(`“${raw}” is not a valid host or user@host:port.`, "error");
    return;
  }

  const ssh = target.user ? `${target.user}@${target.host}` : target.host;
  const taken = loadWorkers().workers.map((worker) => worker.name);
  let name = target.host.replace(/[^A-Za-z0-9._-]/g, "-");
  if (taken.includes(name)) {
    const chosen = await ctx.ui.input(`Name (“${name}” is taken)`, name);
    if (!chosen) return;
    const problem = validateName(chosen.trim(), taken);
    if (problem) {
      ctx.ui.notify(problem, "error");
      return;
    }
    name = chosen.trim();
  }
  const portArgs = target.port ? ["-p", String(target.port)] : [];
  const port = target.port ? { port: target.port } : {};

  if (route.startsWith("I can already")) {
    ctx.ui.notify(`Testing ${ssh}…`, "info");
    const result = await probe(ssh, portArgs);
    if (!result.ok) {
      ctx.ui.notify(
        `Could not connect: ${result.detail}\n\n`
        + "If it needs a password, pick “I have nothing yet” instead — pi cannot answer password prompts.",
        "error",
      );
      return;
    }
    addWorker(name, ssh, port);
    ctx.ui.notify(`${name} added and enabled (${result.detail}).`, "info");
    return;
  }

  if (route.startsWith("I have a private key")) {
    const given = await ctx.ui.input("Key file", "~/.ssh/id_ed25519");
    if (!given) return;
    const expanded = given.startsWith("~/") ? resolve(homedir(), given.slice(2)) : resolve(given);

    // Existence is checked via stat, never by reading: the private key must not
    // enter this process's memory, where it could reach a log or crash dump.
    try {
      if (!statSync(expanded).isFile()) throw new Error("not a file");
    } catch {
      ctx.ui.notify(`No key file at ${given}.`, "error");
      return;
    }

    const result = await probe(ssh, ["-i", expanded, "-o", "IdentitiesOnly=yes", ...portArgs]);
    if (!result.ok) {
      ctx.ui.notify(`Could not connect with that key: ${result.detail}`, "error");
      return;
    }
    addWorker(name, ssh, { identityFile: given, ...port });
    ctx.ui.notify(`${name} added and enabled (${result.detail}).`, "info");
    return;
  }

  let generated: { path: string; publicKey: string };
  try {
    generated = await generateKey(name);
  } catch (error) {
    ctx.ui.notify(`Could not generate a key: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const display = generated.path.replace(homedir(), "~");
  const instructions = [
    "A dedicated key was generated for this server.",
    "",
    "Run ONE of these in your own terminal — pi cannot answer password prompts:",
    "",
    `  ssh-copy-id -i ${display} ${ssh}`,
    "",
    "…or paste this line into ~/.ssh/authorized_keys on the server:",
    "",
    `  ${generated.publicKey}`,
  ].join("\n");

  for (;;) {
    ctx.ui.notify(instructions, "info");
    const choice = await ctx.ui.select("Install the key on the server, then:", [
      "Finished",
      "Show instructions again",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return;
    if (choice === "Show instructions again") continue;

    const result = await probe(ssh, ["-i", generated.path, "-o", "IdentitiesOnly=yes", ...portArgs]);
    if (result.ok) {
      addWorker(name, ssh, { identityFile: display, ...port });
      ctx.ui.notify(`${name} verified and enabled (${result.detail}).`, "info");
      return;
    }
    ctx.ui.notify(`Still cannot connect: ${result.detail}`, "warning");
  }
}

async function renameWorker(ctx: any): Promise<void> {
  const rows = buildRows();
  if (rows.length === 0) {
    ctx.ui.notify("No workers to rename.", "info");
    return;
  }

  const width = Math.max(4, ...rows.map((row) => row.name.length));
  const labels = rows.map((row) => renderRow(row, width));
  const choice = await ctx.ui.select("Rename which worker?", labels);
  if (!choice) return;

  const row = rows[labels.indexOf(choice)];
  if (!row) return;

  const next = await ctx.ui.input(`New name for “${row.name}”`, row.name);
  if (!next) return;
  const trimmed = next.trim();
  if (trimmed === row.name) return;

  const file = loadWorkers();
  const problem = validateName(trimmed, file.workers.map((worker) => worker.name));
  if (problem) {
    ctx.ui.notify(problem, "error");
    return;
  }

  const existing = file.workers.find((worker) => worker.name === row.name);
  if (existing) {
    existing.name = trimmed;
  } else {
    // Renaming a host that was only ever in ssh config materialises it here,
    // keeping `ssh` pointed at the original alias.
    file.workers.push({
      name: trimmed,
      ssh: row.ssh,
      root: "~/remote_tests",
      nice: 10,
      tags: [],
      enabled: row.enabled,
      ...(row.sshHost?.port ? { port: row.sshHost.port } : {}),
    });
  }
  saveWorkers(file);
  ctx.ui.notify(`Renamed ${row.name} → ${trimmed} (still connects to ${row.ssh}).`, "info");
}

async function removeWorker(ctx: any): Promise<void> {
  const stored = loadWorkers().workers;
  if (stored.length === 0) {
    ctx.ui.notify("Nothing to remove — no workers are configured.", "info");
    return;
  }

  const labels = stored.map((worker) => `${worker.name.padEnd(16)} ${worker.ssh}`);
  const choice = await ctx.ui.select("Remove which worker?", labels);
  if (!choice) return;
  const worker = stored[labels.indexOf(choice)];
  if (!worker) return;

  const ok = await ctx.ui.confirm(
    `Remove ${worker.name}?`,
    "This only edits pi-plus.json. Nothing on the server or in ~/.ssh/config is touched.",
  );
  if (!ok) return;

  const file = loadWorkers();
  file.workers = file.workers.filter((candidate) => candidate.name !== worker.name);
  saveWorkers(file);
  ctx.ui.notify(`Removed ${worker.name}.`, "info");
}

async function hub(ctx: any): Promise<void> {
  const ADD = "+ Add a server…";
  const RENAME = "✎ Rename…";
  const REMOVE = "− Remove…";

  for (;;) {
    const rows = buildRows();
    const width = Math.max(4, ...rows.map((row) => row.name.length), 4);
    const labels = rows.map((row) => renderRow(row, width));
    const actions = rows.length > 0 ? [ADD, RENAME, REMOVE] : [ADD];

    const choice = await ctx.ui.select(
      rows.length === 0 ? "No remote workers yet — add one" : "Remote workers — enter toggles, esc closes",
      [...labels, ...actions],
    );
    if (!choice) return;

    if (choice === ADD) {
      await addServer(ctx);
      continue;
    }
    if (choice === RENAME) {
      await renameWorker(ctx);
      continue;
    }
    if (choice === REMOVE) {
      await removeWorker(ctx);
      continue;
    }

    const row = rows[labels.indexOf(choice)];
    if (row) setEnabled(row, !row.enabled);
  }
}

export function registerRemoteSetup(pi: ExtensionAPI): void {
  pi.registerCommand("remote", {
    description: "Manage remote test workers (setup | add | remove | rename)",
    getArgumentCompletions: (prefix) =>
      ["setup", "add", "remove", "rename"]
        .filter((option) => option.startsWith(prefix))
        .map((option) => ({ value: option, label: option })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      // Every interactive path needs ui.select, so headless sessions get the
      // plain summary instead.
      if (!ctx.hasUI) {
        const rows = buildRows();
        ctx.ui.notify(
          rows.length === 0
            ? "No hosts found. Run /remote add to configure one."
            : rows.map((row) => `${row.enabled ? "[on] " : "[off]"} ${row.name} — ${row.detail}`).join("\n"),
          "info",
        );
        return;
      }

      if (action === "add") return addServer(ctx);
      if (action === "remove") return removeWorker(ctx);
      if (action === "rename") return renameWorker(ctx);

      // `setup` is the documented entry point; a bare /remote is the same hub.
      if (action && action !== "setup") {
        ctx.ui.notify(`Unknown action “${action}”. Use: /remote [setup|add|remove|rename]`, "warning");
        return;
      }

      return hub(ctx);
    },
  });
}
