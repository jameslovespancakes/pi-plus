import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Minimal `~/.ssh/config` reader.
 *
 * Deliberately narrow: it extracts only what is needed to offer a host as a
 * remote worker — the alias, HostName, User, Port, and whether an IdentityFile
 * is configured. It never reads key material, and callers must keep the results
 * in the UI layer: host aliases frequently name internal infrastructure and have
 * no business being sent to a model provider.
 */

export interface SshHost {
  /** The `Host` alias, which is what you pass to `ssh`. */
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  /** Path as written in the config. The file is never opened. */
  identityFile?: string;
  /** Config file this block came from, for display. */
  source: string;
}

function defaultConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

/** `Host` patterns that cannot be connected to directly. */
function isPattern(alias: string): boolean {
  return alias.includes("*") || alias.includes("?") || alias.startsWith("!");
}

function expandPath(value: string, base: string): string {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : join(base, value);
}

/**
 * Parses one config file, following `Include` directives.
 * `seen` guards against include cycles.
 */
function parseFile(path: string, seen: Set<string>, out: SshHost[]): void {
  if (seen.has(path)) return;
  seen.add(path);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // Missing or unreadable config is simply "no hosts".
  }

  let current: SshHost | undefined;
  const push = () => {
    if (current && !isPattern(current.alias)) out.push(current);
    current = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Keywords are case-insensitive; separator is whitespace or '='.
    const match = /^([A-Za-z]+)[\s=]+(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim().replace(/^"(.*)"$/, "$1");
    if (!value) continue;

    if (keyword === "host") {
      push();
      // `Host a b c` declares several aliases; the first connectable one wins.
      const alias = value.split(/\s+/).find((candidate) => !isPattern(candidate));
      if (alias) current = { alias, source: path };
      continue;
    }

    if (keyword === "include") {
      // Includes are resolved relative to the containing file's directory.
      for (const pattern of value.split(/\s+/)) {
        const resolved = expandPath(pattern, dirname(path));
        let matches: string[] = [];
        try {
          matches = globSync(resolved);
        } catch {
          matches = [];
        }
        // A literal path that does not glob should still be attempted.
        for (const file of matches.length > 0 ? matches : [resolved]) parseFile(file, seen, out);
      }
      continue;
    }

    if (!current) continue;
    switch (keyword) {
      case "hostname":
        current.hostName = value;
        break;
      case "user":
        current.user = value;
        break;
      case "port": {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port < 65536) current.port = port;
        break;
      }
      case "identityfile":
        // Recorded as a path only. The key itself is never read.
        current.identityFile ??= value;
        break;
      default:
        break;
    }
  }
  push();
}

/** Every connectable host in the user's SSH config, in file order. */
export function readSshHosts(path = defaultConfigPath()): SshHost[] {
  const hosts: SshHost[] = [];
  parseFile(path, new Set(), hosts);

  // A later duplicate alias never overrides the first, matching ssh semantics.
  const byAlias = new Map<string, SshHost>();
  for (const host of hosts) if (!byAlias.has(host.alias)) byAlias.set(host.alias, host);
  return [...byAlias.values()];
}

/** `deploy@203.0.113.9:2222` -> parts. Bare `host` is valid. */
export function parseTarget(input: string): { user?: string; host: string; port?: number } | undefined {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;

  const at = trimmed.lastIndexOf("@");
  if (at === 0) return undefined; // "@host" has an empty user
  const user = at > 0 ? trimmed.slice(0, at) : undefined;
  let rest = at > 0 ? trimmed.slice(at + 1) : trimmed;

  let port: number | undefined;
  // Only treat a trailing :N as a port; IPv6 literals keep their colons.
  const portMatch = /^(.*):(\d+)$/.exec(rest);
  if (portMatch && !portMatch[1].includes(":")) {
    rest = portMatch[1];
    port = Number(portMatch[2]);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
  }

  if (!rest) return undefined;
  // A leftover single colon is a malformed port ("host:abc"). Genuine IPv6
  // literals always carry at least two.
  if (rest.includes(":") && (rest.match(/:/g)?.length ?? 0) < 2) return undefined;
  return { user, host: rest, port };
}
