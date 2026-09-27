
export interface Limits {
	cpuBlockPercent: number;
	gpuBlockPercent: number;
	gpuMemoryBlockPercent: number;
	memoryBlockPercent: number;
	minimumFreeDiskGB: number;
	retentionHours: number;
}

export interface WorkerInput extends Partial<Limits> {
	name: string;
	ssh: string;
	root?: string;
	nice?: number;
	tags?: string[];
	/** Explicit key path, for hosts added without an ~/.ssh/config entry. */
	identityFile?: string;
	port?: number;
	/** Toggled off in the picker without losing the entry. */
	enabled?: boolean;
}

// WorkerInput carries the same limit keys as optional overrides, so they must be
// stripped before re-declaring them as required or the two bases conflict.
export interface Worker extends Omit<WorkerInput, keyof Limits | "enabled">, Limits {
	enabled: boolean;
	root: string;
	nice: number;
	tags: string[];
}

export interface Config {
	workers: Worker[];
}

export interface WorkerStatus {
	name: string;
	ssh: string;
	os?: string;
	state: "ready" | "blocked" | "unreachable";
	cpuPercent?: number;
	memoryPercent?: number;
	gpuPercent?: number;
	gpuMemoryPercent?: number;
	freeDiskGB?: number;
	jobs?: number;
	gpuJobs?: number;
	thermal?: string;
	modelMode?: boolean;
	reasons: string[];
	tags: string[];
	sampledAt: string;
}

export interface SnapshotResult {
	tempDir: string;
	archivePath: string;
	repoRoot: string;
	repoName: string;
	mode: "working-tree" | "tracked" | "paths";
	files: string[];
	fingerprint: string;
	archiveBytes: number;
	commit: string;
	dirty: boolean;
}
