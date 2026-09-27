import { readRemote } from "../../core/exec/hosts.ts";
import { type Config, type Limits, type Worker, type WorkerInput } from "./types.ts";

const DEFAULT_LIMITS: Limits = {
	cpuBlockPercent: 90,
	gpuBlockPercent: 90,
	gpuMemoryBlockPercent: 90,
	memoryBlockPercent: 90,
	minimumFreeDiskGB: 10,
	retentionHours: 24,
};

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export async function loadConfig(): Promise<Config> {
	// The `remote` section of pi-plus.json. An empty worker list is the normal
	// first-run state: /remote setup populates it.
	const parsed = readRemote();
	const defaults = parsed.defaults ?? {};
	const defaultLimits: Limits = {
		cpuBlockPercent: finiteNumber(defaults.cpuBlockPercent, DEFAULT_LIMITS.cpuBlockPercent, 1, 100),
		gpuBlockPercent: finiteNumber(defaults.gpuBlockPercent, DEFAULT_LIMITS.gpuBlockPercent, 1, 100),
		gpuMemoryBlockPercent: finiteNumber(
			defaults.gpuMemoryBlockPercent,
			DEFAULT_LIMITS.gpuMemoryBlockPercent,
			1,
			100,
		),
		memoryBlockPercent: finiteNumber(defaults.memoryBlockPercent, DEFAULT_LIMITS.memoryBlockPercent, 1, 100),
		minimumFreeDiskGB: finiteNumber(defaults.minimumFreeDiskGB, DEFAULT_LIMITS.minimumFreeDiskGB, 0, 100000),
		retentionHours: finiteNumber(defaults.retentionHours, DEFAULT_LIMITS.retentionHours, 1, 24 * 365),
	};
	const names = new Set<string>();
	const workers: Worker[] = parsed.workers.map((raw: WorkerInput, index: number) => {
		if (!raw || typeof raw.name !== "string" || !raw.name.trim() || typeof raw.ssh !== "string" || !raw.ssh.trim()) {
			throw new Error(`Invalid worker at index ${index}: name and ssh are required strings.`);
		}
		if (names.has(raw.name)) throw new Error(`Duplicate remote worker name: ${raw.name}`);
		names.add(raw.name);
		const root = typeof raw.root === "string" && raw.root.trim() ? raw.root.trim() : "~/remote_tests";
		if (root.includes("\n") || root.includes("\0") || (!root.startsWith("~/") && !root.startsWith("/"))) {
			throw new Error(`Worker ${raw.name} root must be an absolute POSIX path or start with ~/`);
		}
		return {
			name: raw.name.trim(),
			ssh: raw.ssh.trim(),
			root,
			enabled: raw.enabled !== false,
			identityFile: typeof raw.identityFile === "string" && raw.identityFile.trim() ? raw.identityFile.trim() : undefined,
			port: Number.isInteger(raw.port) && raw.port! > 0 && raw.port! < 65536 ? raw.port : undefined,
			nice: Math.floor(finiteNumber(raw.nice, 10, 0, 19)),
			tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
			cpuBlockPercent: finiteNumber(raw.cpuBlockPercent, defaultLimits.cpuBlockPercent, 1, 100),
			gpuBlockPercent: finiteNumber(raw.gpuBlockPercent, defaultLimits.gpuBlockPercent, 1, 100),
			gpuMemoryBlockPercent: finiteNumber(
				raw.gpuMemoryBlockPercent,
				defaultLimits.gpuMemoryBlockPercent,
				1,
				100,
			),
			memoryBlockPercent: finiteNumber(raw.memoryBlockPercent, defaultLimits.memoryBlockPercent, 1, 100),
			minimumFreeDiskGB: finiteNumber(raw.minimumFreeDiskGB, defaultLimits.minimumFreeDiskGB, 0, 100000),
			retentionHours: finiteNumber(raw.retentionHours, defaultLimits.retentionHours, 1, 24 * 365),
		};
	});
	return { workers };
}
