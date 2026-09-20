import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { agentPath, writeJson } from "../../core/store.ts";
import type { ArchiveRecord, SemanticChunk, SuperContextArchive } from "./types.ts";

function safeSessionId(sessionId: string): string {
  const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "session";
  const suffix = createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
  return `${readable}-${suffix}`;
}

export function archivePath(sessionId: string): string {
  return agentPath("super-context", "archives", `${safeSessionId(sessionId)}.json`);
}

function emptyArchive(sessionId: string): SuperContextArchive {
  return { version: 1, sessionId, records: [], checkpoints: {} };
}

function isArchiveRecord(value: unknown): value is ArchiveRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArchiveRecord>;
  return typeof record.id === "string"
    && typeof record.hash === "string"
    && typeof record.text === "string"
    && typeof record.role === "string"
    && typeof record.ordinal === "number"
    && typeof record.archivedAt === "string";
}

/** Refuse to overwrite a corrupt archive: source recoverability wins over convenience. */
export function loadArchive(sessionId: string): SuperContextArchive {
  const path = archivePath(sessionId);
  if (!existsSync(path)) return emptyArchive(sessionId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Super Context archive is unreadable; refusing to overwrite ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid Super Context archive: ${path}`);
  const candidate = parsed as Partial<SuperContextArchive>;
  if (candidate.version !== 1 || candidate.sessionId !== sessionId || !Array.isArray(candidate.records)) {
    throw new Error(`Unsupported Super Context archive format: ${path}`);
  }
  if (!candidate.records.every(isArchiveRecord)) throw new Error(`Invalid Super Context archive records: ${path}`);
  const checkpoints = candidate.checkpoints;
  if (!checkpoints || typeof checkpoints !== "object" || Array.isArray(checkpoints)) {
    throw new Error(`Invalid Super Context archive checkpoints: ${path}`);
  }
  for (const ids of Object.values(checkpoints)) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error(`Invalid Super Context archive checkpoint: ${path}`);
    }
  }
  return candidate as SuperContextArchive;
}

function addChunks(archive: SuperContextArchive, chunks: readonly SemanticChunk[]): void {
  const byId = new Map(archive.records.map((record) => [record.id, record]));
  let ordinal = archive.records.reduce((maximum, record) => Math.max(maximum, record.ordinal), -1) + 1;
  const archivedAt = new Date().toISOString();
  for (const chunk of chunks) {
    const existing = byId.get(chunk.id);
    if (existing) {
      if (existing.hash !== chunk.hash || existing.text !== chunk.text) {
        throw new Error(`Super Context archive ID collision for ${chunk.id}`);
      }
      continue;
    }
    const record: ArchiveRecord = { ...chunk, ordinal, archivedAt };
    ordinal += 1;
    archive.records.push(record);
    byId.set(record.id, record);
  }
}

function checkpointHash(recordIds: readonly string[]): string {
  const digest = createHash("sha256").update(recordIds.join("\0")).digest("hex");
  return `SCC-${digest.slice(0, 20)}`;
}

export interface PersistedCheckpoint {
  archive: SuperContextArchive;
  checkpointId: string;
  records: ArchiveRecord[];
  duplicateChunks: number;
  file: string;
}

/** Add-only persistence for immutable records and content-addressed checkpoints. */
export function persistCheckpoint(
  sessionId: string,
  chunks: readonly SemanticChunk[],
  priorRecordIds: readonly string[],
): PersistedCheckpoint {
  const archive = loadArchive(sessionId);
  const currentIds = chunks.map((chunk) => chunk.id);
  const allRecordIds = [...priorRecordIds, ...currentIds];
  const duplicateChunks = allRecordIds.length - new Set(allRecordIds).size;
  addChunks(archive, chunks);

  const knownIds = new Set(archive.records.map((record) => record.id));
  const recordIds = [...new Set(allRecordIds)];
  const missing = recordIds.filter((id) => !knownIds.has(id));
  if (missing.length > 0) throw new Error(`Super Context archive is missing ${missing.length} source record(s)`);

  const checkpointId = checkpointHash(recordIds);
  const existing = archive.checkpoints[checkpointId];
  if (existing && JSON.stringify(existing) !== JSON.stringify(recordIds)) {
    throw new Error(`Super Context checkpoint collision for ${checkpointId}`);
  }
  archive.checkpoints[checkpointId] ??= recordIds;

  const file = archivePath(sessionId);
  if (!writeJson(file, archive, false, 0o600)) throw new Error(`Failed to persist Super Context archive: ${file}`);
  const byId = new Map(archive.records.map((record) => [record.id, record]));
  return {
    archive,
    checkpointId,
    records: recordIds.map((id) => byId.get(id)!),
    duplicateChunks,
    file,
  };
}

export function checkpointRecords(archive: SuperContextArchive, checkpointId: string | undefined): ArchiveRecord[] {
  if (!checkpointId) return [];
  const ids = archive.checkpoints[checkpointId];
  if (!ids) return [];
  const byId = new Map(archive.records.map((record) => [record.id, record]));
  const records = ids.map((id) => byId.get(id)).filter((record): record is ArchiveRecord => record !== undefined);
  return records.length === ids.length ? records : [];
}

export function archiveDisplayName(file: string): string {
  return basename(file);
}
