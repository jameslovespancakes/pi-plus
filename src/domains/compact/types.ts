export type BetterCompactMode = "off" | "on" | "jev";

export const COMPRESSION_ROUTES = ["EXACT", "2X", "4X", "8X", "16X", "ARCHIVE", "DROP"] as const;
export type CompressionRoute = (typeof COMPRESSION_ROUTES)[number];

export type ChunkRole = "user" | "assistant" | "tool" | "custom" | "summary";
export type ArchiveSource = "conversation" | "legacy-summary";

export interface SourceItem {
  role: ChunkRole;
  text: string;
  source: ArchiveSource;
}

export interface SemanticChunk {
  id: string;
  hash: string;
  role: ChunkRole;
  text: string;
  tokens: number;
  source: ArchiveSource;
  protected: boolean;
  exactHeavy: boolean;
  quarantined: boolean;
}

export interface ArchiveRecord extends SemanticChunk {
  ordinal: number;
  archivedAt: string;
}

export interface SuperContextArchive {
  version: 1;
  sessionId: string;
  records: ArchiveRecord[];
  checkpoints: Record<string, string[]>;
}

export interface ClassifierScores {
  relevance: number;
  exactness: number;
  futureValue: number;
  recoverability: number;
  redundancy: number;
  confidence: number;
}

export interface RouteDecision {
  record: ArchiveRecord;
  route: CompressionRoute;
  reason: string;
  importance?: number;
  scores?: ClassifierScores;
}

export interface JevUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  resolvedModels: string[];
}

export interface SuperContextDetails {
  kind: "pi-plus-super-context";
  version: 1;
  mode: Exclude<BetterCompactMode, "off">;
  checkpointId: string;
  archiveFile: string;
  sourceRecords: number;
  duplicateChunksDropped: number;
  routeCounts: Record<CompressionRoute, number>;
  sourceChars: number;
  activeChars: number;
  reduction: number;
  jev?: JevUsage & { fallback?: string };
  readFiles: string[];
  modifiedFiles: string[];
}
