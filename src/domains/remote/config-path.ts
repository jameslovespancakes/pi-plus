import { readConfig, updateConfig } from "../../core/config.ts";

/**
 * Accessors for the `remote` section of `pi-plus.json`.
 *
 * The worker list previously lived in its own `remote-workers.json`, then
 * `remote.json`. Both are migrated by core/config.ts on first read.
 */

export interface RemoteWorkerRecord {
  name: string;
  ssh: string;
  root?: string;
  nice?: number;
  tags?: string[];
  identityFile?: string;
  port?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface RemoteSettings {
  defaults: Record<string, unknown>;
  workers: RemoteWorkerRecord[];
}

export function readRemote(): RemoteSettings {
  const section = readConfig().remote;
  return {
    defaults: (section.defaults as Record<string, unknown>) ?? {},
    workers: (section.workers as RemoteWorkerRecord[]) ?? [],
  };
}

export function writeRemoteWorkers(workers: RemoteWorkerRecord[]): boolean {
  return updateConfig((config) => {
    config.remote.workers = workers;
  });
}
