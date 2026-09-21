import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { registerRemoteSetup } from "./setup.ts";
import { readRemote } from "./config-path.ts";
import { Type } from "typebox";
import {
	appendTail,
	shQuote,
	rootAssignment,
	runLocal,
	runProcess,
	runSshCommand,
	type ProcessResult,
	type RunOptions,
} from "../../core/exec/process.ts";

interface Limits {
	cpuBlockPercent: number;
	gpuBlockPercent: number;
	gpuMemoryBlockPercent: number;
	memoryBlockPercent: number;
	minimumFreeDiskGB: number;
	retentionHours: number;
}

interface WorkerInput extends Partial<Limits> {
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
interface Worker extends Omit<WorkerInput, keyof Limits | "enabled">, Limits {
	enabled: boolean;
	root: string;
	nice: number;
	tags: string[];
}

interface Config {
	workers: Worker[];
}

interface WorkerStatus {
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

interface SnapshotResult {
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

const DEFAULT_LIMITS: Limits = {
	cpuBlockPercent: 90,
	gpuBlockPercent: 90,
	gpuMemoryBlockPercent: 90,
	memoryBlockPercent: 90,
	minimumFreeDiskGB: 10,
	retentionHours: 24,
};

const HARD_WALK_EXCLUDES = new Set([
	".git",
	"node_modules",
	".venv",
	"__pycache__",
	"target",
	"dist",
	"build",
	"coverage",
	".next",
	"remote_tests",
]);

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

async function loadConfig(): Promise<Config> {
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

/** `-i`/`-p` only when the worker was added without an ~/.ssh/config entry. */
function sshArgsFor(worker: Worker): string[] {
	const args: string[] = [];
	if (worker.identityFile) {
		const expanded = worker.identityFile.startsWith("~/")
			? resolve(homedir(), worker.identityFile.slice(2))
			: worker.identityFile;
		args.push("-i", expanded, "-o", "IdentitiesOnly=yes");
	}
	if (worker.port) args.push("-p", String(worker.port));
	return args;
}

async function runSsh(
	worker: Worker,
	remoteCommand: string,
	options: RunOptions = {},
): Promise<ProcessResult> {
	return runSshCommand(worker.ssh, remoteCommand, options, sshArgsFor(worker));
}

function healthScript(worker: Worker): string {
	return `
set +e
LC_ALL=C
${rootAssignment(worker.root)}
OS=$(uname -s 2>/dev/null || echo unknown)
CPU=-1
MEM=-1
GPU=-1
GPU_MEM=-1
THERMAL=normal
if [ "$OS" = Darwin ]; then
  CORES=$(sysctl -n hw.logicalcpu 2>/dev/null || echo 1)
  CPU=$(ps -A -o %cpu= 2>/dev/null | awk -v c="$CORES" '{s+=$1} END {if(c<1)c=1; v=s/c; if(v>100)v=100; printf "%.1f",v}')
  FREE=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/System-wide memory free percentage/ {gsub(/%/,"",$2); print $2; exit}')
  if [ -n "$FREE" ]; then MEM=$(awk -v f="$FREE" 'BEGIN {printf "%.1f",100-f}'); fi
  if ! pmset -g therm 2>/dev/null | grep -q 'No thermal warning level'; then THERMAL=warning; fi
else
  set -- $(awk '/^cpu / {idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total,idle; exit}' /proc/stat 2>/dev/null)
  T1=$1; I1=$2
  sleep 0.4
  set -- $(awk '/^cpu / {idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; print total,idle; exit}' /proc/stat 2>/dev/null)
  T2=$1; I2=$2
  if [ -n "$T1" ] && [ "$T2" -gt "$T1" ] 2>/dev/null; then CPU=$(awk -v t1="$T1" -v i1="$I1" -v t2="$T2" -v i2="$I2" 'BEGIN {printf "%.1f",100*(1-(i2-i1)/(t2-t1))}'); fi
  MEM=$(awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {if(t>0) printf "%.1f",100*(t-a)/t; else print -1}' /proc/meminfo 2>/dev/null)
  if command -v nvidia-smi >/dev/null 2>&1; then
    GPU_LINE=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    GPU=$(printf '%s' "$GPU_LINE" | cut -d, -f1)
    GPU_USED=$(printf '%s' "$GPU_LINE" | cut -d, -f2)
    GPU_TOTAL=$(printf '%s' "$GPU_LINE" | cut -d, -f3)
    if [ -n "$GPU_TOTAL" ] && [ "$GPU_TOTAL" -gt 0 ] 2>/dev/null; then GPU_MEM=$(awk -v u="$GPU_USED" -v t="$GPU_TOTAL" 'BEGIN {printf "%.1f",100*u/t}'); fi
  fi
fi
FREE_KB=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')
FREE_GB=$(awk -v k="\${FREE_KB:-0}" 'BEGIN {printf "%.1f",k/1048576}')
JOBS=0
GPU_JOBS=0
for d in "$ROOT/.slots"/*; do
  [ -d "$d" ] || continue
  JOBS=$((JOBS+1))
  [ -f "$d/gpu" ] && GPU_JOBS=$((GPU_JOBS+1))
done
MODEL_MODE=0
if [ -e "$ROOT/.model-mode" ] || [ -e "$HOME/.model-mode" ]; then MODEL_MODE=1; fi
printf 'OS=%s\nCPU=%s\nMEM=%s\nGPU=%s\nGPU_MEM=%s\nFREE_GB=%s\nJOBS=%s\nGPU_JOBS=%s\nTHERMAL=%s\nMODEL_MODE=%s\n' "$OS" "$CPU" "$MEM" "$GPU" "$GPU_MEM" "$FREE_GB" "$JOBS" "$GPU_JOBS" "$THERMAL" "$MODEL_MODE"
`;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function probeWorker(worker: Worker): Promise<WorkerStatus> {
	const sampledAt = new Date().toISOString();
	try {
		const result = await runSsh(worker, "bash -s", { input: healthScript(worker), timeoutSeconds: 12 });
		if (result.code !== 0 || result.timedOut || result.aborted) {
			const message = result.timedOut ? "health check timed out" : (result.stderr.trim() || `SSH exited ${result.code}`);
			return {
				name: worker.name,
				ssh: worker.ssh,
				state: "unreachable",
				reasons: [message],
				tags: worker.tags,
				sampledAt,
			};
		}
		const values = new Map<string, string>();
		for (const line of result.stdout.split(/\r?\n/)) {
			const separator = line.indexOf("=");
			if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
		}
		const cpuPercent = parseNumber(values.get("CPU"));
		const memoryPercent = parseNumber(values.get("MEM"));
		const gpuPercent = parseNumber(values.get("GPU"));
		const gpuMemoryPercent = parseNumber(values.get("GPU_MEM"));
		const freeDiskGB = parseNumber(values.get("FREE_GB"));
		const jobs = parseNumber(values.get("JOBS")) ?? 0;
		const gpuJobs = parseNumber(values.get("GPU_JOBS")) ?? 0;
		const thermal = values.get("THERMAL") || "unknown";
		const modelMode = values.get("MODEL_MODE") === "1";
		const reasons: string[] = [];
		if (modelMode) reasons.push("model mode is active");
		if (cpuPercent !== undefined && cpuPercent >= worker.cpuBlockPercent) {
			reasons.push(`CPU ${cpuPercent.toFixed(1)}% >= ${worker.cpuBlockPercent}%`);
		}
		if (memoryPercent !== undefined && memoryPercent >= worker.memoryBlockPercent) {
			reasons.push(`memory ${memoryPercent.toFixed(1)}% >= ${worker.memoryBlockPercent}%`);
		}
		if (gpuPercent !== undefined && gpuPercent >= worker.gpuBlockPercent) {
			reasons.push(`GPU ${gpuPercent.toFixed(1)}% >= ${worker.gpuBlockPercent}%`);
		}
		if (gpuMemoryPercent !== undefined && gpuMemoryPercent >= worker.gpuMemoryBlockPercent) {
			reasons.push(`GPU memory ${gpuMemoryPercent.toFixed(1)}% >= ${worker.gpuMemoryBlockPercent}%`);
		}
		if (freeDiskGB !== undefined && freeDiskGB < worker.minimumFreeDiskGB) {
			reasons.push(`free disk ${freeDiskGB.toFixed(1)} GB < ${worker.minimumFreeDiskGB} GB`);
		}
		if (thermal !== "normal") reasons.push(`thermal state ${thermal}`);
		return {
			name: worker.name,
			ssh: worker.ssh,
			os: values.get("OS"),
			state: reasons.length ? "blocked" : "ready",
			cpuPercent,
			memoryPercent,
			gpuPercent,
			gpuMemoryPercent,
			freeDiskGB,
			jobs,
			gpuJobs,
			thermal,
			modelMode,
			reasons,
			tags: worker.tags,
			sampledAt,
		};
	} catch (error) {
		return {
			name: worker.name,
			ssh: worker.ssh,
			state: "unreachable",
			reasons: [error instanceof Error ? error.message : String(error)],
			tags: worker.tags,
			sampledAt,
		};
	}
}

async function probeWorkers(config: Config): Promise<WorkerStatus[]> {
	const active = config.workers.filter((worker) => worker.enabled);
	return Promise.all(active.map(probeWorker));
}

function metric(value: number | undefined): string {
	return value === undefined ? "?" : `${Math.round(value)}%`;
}

function detailedStatuses(statuses: WorkerStatus[]): string {
	return statuses
		.map((status) => {
			const fields = [
				`${status.name.padEnd(10)} ${status.state.toUpperCase().padEnd(11)}`,
				`CPU ${metric(status.cpuPercent).padStart(4)}`,
				`MEM ${metric(status.memoryPercent).padStart(4)}`,
				`GPU ${metric(status.gpuPercent).padStart(4)}`,
				`VRAM ${metric(status.gpuMemoryPercent).padStart(4)}`,
				`disk ${status.freeDiskGB === undefined ? "?" : `${status.freeDiskGB.toFixed(1)}GB`}`,
				`active-jobs ${status.jobs ?? "?"}`,
			];
			return fields.join("  ") + (status.reasons.length ? `\n  blocked: ${status.reasons.join("; ")}` : "");
		})
		.join("\n");
}

function normalizeRepoPath(input: string): string {
	const value = input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (value === "." || value === "") return "";
	if (value.includes("\0") || value.includes("\n") || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
		throw new Error(`Snapshot path must be repository-relative: ${input}`);
	}
	const parts = value.split("/");
	if (parts.some((part) => part === "..")) throw new Error(`Snapshot path escapes the repository: ${input}`);
	if (parts.some((part) => part === ".git")) throw new Error(`Snapshot paths cannot include .git: ${input}`);
	return parts.filter((part) => part && part !== ".").join("/");
}

function matchesPath(file: string, selected: string): boolean {
	return selected === "" || file === selected || file.startsWith(`${selected}/`);
}

async function walkFiles(root: string, current = ""): Promise<string[]> {
	const directory = resolve(root, current || ".");
	const entries = await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }));
	const files: string[] = [];
	for (const entry of entries) {
		if (HARD_WALK_EXCLUDES.has(entry.name)) continue;
		const rel = current ? `${current}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await walkFiles(root, rel)));
		else if (entry.isFile() || entry.isSymbolicLink()) files.push(rel);
	}
	return files;
}

async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
	const result = await runLocal("git", ["-C", repoRoot, ...args]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

async function resolveRepository(repositoryPath: string | undefined, cwd: string): Promise<string> {
	const candidate = resolve(cwd, repositoryPath?.replace(/^@/, "") || ".");
	const result = await runLocal("git", ["-C", candidate, "rev-parse", "--show-toplevel"]);
	if (result.code !== 0) throw new Error(`${candidate} is not inside a Git repository.`);
	return resolve(result.stdout.trim());
}

async function selectFiles(
	repoRoot: string,
	mode: "working-tree" | "tracked" | "paths",
	paths: string[],
	excludes: string[],
	includeIgnored: boolean,
): Promise<string[]> {
	let files: string[];
	if (includeIgnored && mode !== "tracked") {
		files = await walkFiles(repoRoot);
	} else {
		const args = mode === "tracked" ? ["ls-files", "-z", "--cached"] : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
		files = (await gitOutput(repoRoot, args)).split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/"));
	}
	const normalizedPaths = paths.map(normalizeRepoPath);
	const normalizedExcludes = excludes.map(normalizeRepoPath);
	if (mode === "paths") {
		if (normalizedPaths.length === 0) throw new Error('snapshot.mode "paths" requires at least one path.');
		files = files.filter((file) => normalizedPaths.some((selected) => matchesPath(file, selected)));
	}
	files = files.filter((file) => !normalizedExcludes.some((excluded) => matchesPath(file, excluded)));
	const existing: string[] = [];
	for (const file of [...new Set(files)].sort()) {
		const absolute = resolve(repoRoot, file.split("/").join(sep));
		if (relative(repoRoot, absolute).startsWith("..")) continue;
		try {
			const stat = await lstat(absolute);
			if (stat.isFile() || stat.isSymbolicLink()) existing.push(file);
		} catch {
			// Deleted tracked files are intentionally absent from the snapshot.
		}
	}
	if (existing.length === 0) throw new Error("Snapshot selection contains no files.");
	return existing;
}

async function fileStamp(repoRoot: string, files: string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const file of files) {
		const absolute = resolve(repoRoot, file.split("/").join(sep));
		const stat = await lstat(absolute);
		hash.update(file).update("\0").update(`${stat.size}:${stat.mtimeMs}:${stat.mode}`).update("\0");
		if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
	}
	return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolvePromise(hash.digest("hex")));
	});
}

async function createSnapshot(
	cwd: string,
	params: {
		repositoryPath?: string;
		snapshot?: {
			mode?: "working-tree" | "tracked" | "paths";
			paths?: string[];
			excludePaths?: string[];
			includeIgnored?: boolean;
		};
	},
): Promise<SnapshotResult> {
	const repoRoot = await resolveRepository(params.repositoryPath, cwd);
	const mode = params.snapshot?.mode ?? "working-tree";
	const paths = params.snapshot?.paths ?? [];
	const excludes = params.snapshot?.excludePaths ?? [];
	const includeIgnored = params.snapshot?.includeIgnored ?? false;
	const repoName = basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
	const tempDir = await mkdtemp(resolve(tmpdir(), "pi-remote-test-"));
	const archivePath = resolve(tempDir, "snapshot.tar.gz");
	try {
		for (let attempt = 1; attempt <= 2; attempt++) {
			const files = await selectFiles(repoRoot, mode, paths, excludes, includeIgnored);
			const before = await fileStamp(repoRoot, files);
			const listPath = resolve(tempDir, "files.nul");
			await writeFile(listPath, Buffer.from(`${files.join("\0")}\0`, "utf8"), { mode: 0o600 });
			const tar = await runProcess("tar", ["-czf", archivePath, "-C", repoRoot, "--no-recursion", "--null", "-T", listPath], {
				timeoutSeconds: 300,
			});
			if (tar.code !== 0) throw new Error(tar.stderr.trim() || "Failed to create snapshot archive.");
			const after = await fileStamp(repoRoot, files);
			if (before !== after) {
				if (attempt === 2) throw new Error("Selected files changed while the snapshot was being created; retry after edits settle.");
				continue;
			}
			const stat = await lstat(archivePath);
			const commit = (await gitOutput(repoRoot, ["rev-parse", "HEAD"])).trim();
			const dirty = (await gitOutput(repoRoot, ["status", "--porcelain", "--untracked-files=normal"])).length > 0;
			return {
				tempDir,
				archivePath,
				repoRoot,
				repoName,
				mode,
				files,
				fingerprint: await sha256File(archivePath),
				archiveBytes: stat.size,
				commit,
				dirty,
			};
		}
		throw new Error("Snapshot creation failed.");
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

function gpuCapable(worker: Worker): boolean {
	return worker.tags.some((tag) => ["gpu", "cuda", "metal"].includes(tag.toLowerCase()));
}

function pickWorker(config: Config, statuses: WorkerStatus[], requested: string, requiresGpu: boolean): Worker | undefined {
	if (requested !== "auto") return config.workers.find((worker) => worker.enabled && worker.name === requested);
	const ready = statuses
		.filter((status) => status.state === "ready")
		.map((status) => ({ status, worker: config.workers.find((worker) => worker.name === status.name)! }))
		.filter(({ worker }) => worker && (!requiresGpu || gpuCapable(worker)));
	ready.sort((a, b) => {
		const score = (item: (typeof ready)[number]) =>
			Math.max(item.status.cpuPercent ?? 0, item.status.memoryPercent ?? 0, item.status.gpuPercent ?? 0);
		return score(a) - score(b);
	});
	return ready[0]?.worker;
}

function reserveScript(worker: Worker, jobId: string, requiresGpu: boolean): string {
	return `
set -u
${rootAssignment(worker.root)}
mkdir -p "$ROOT/.slots"
LOCK="$ROOT/.admission.lock"
NOW=$(date +%s)
for d in "$ROOT/.slots"/*; do
  [ -d "$d" ] || continue
  CREATED=$(cat "$d/created" 2>/dev/null || echo "$NOW")
  if [ $((NOW-CREATED)) -gt 21600 ]; then rm -rf "$d"; fi
done
ACQUIRED=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if mkdir "$LOCK" 2>/dev/null; then ACQUIRED=1; break; fi
  sleep 0.1
done
if [ "$ACQUIRED" -ne 1 ]; then echo 'ADMITTED=0'; echo 'REASON=admission lock busy'; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
if [ -e "$ROOT/.model-mode" ] || [ -e "$HOME/.model-mode" ]; then echo 'ADMITTED=0'; echo 'REASON=model mode is active'; exit 0; fi
SLOT="$ROOT/.slots/${jobId}"
if ! mkdir "$SLOT" 2>/dev/null; then echo 'ADMITTED=0'; echo 'REASON=job slot collision'; exit 0; fi
printf '%s\n' "$NOW" > "$SLOT/created"
${requiresGpu ? 'touch "$SLOT/gpu"' : ":"}
echo 'ADMITTED=1'
`;
}

async function reserveWorker(worker: Worker, jobId: string, requiresGpu: boolean): Promise<{ admitted: boolean; reason?: string }> {
	const result = await runSsh(worker, "bash -s", { input: reserveScript(worker, jobId, requiresGpu), timeoutSeconds: 15 });
	if (result.code !== 0) return { admitted: false, reason: result.stderr.trim() || `slot reservation exited ${result.code}` };
	const admitted = /(^|\n)ADMITTED=1(\n|$)/.test(result.stdout);
	const reason = result.stdout.match(/(?:^|\n)REASON=([^\n]+)/)?.[1];
	return { admitted, reason };
}

async function releaseWorker(worker: Worker, jobId: string): Promise<void> {
	const script = `${rootAssignment(worker.root)}\nrm -rf "$ROOT/.slots/${jobId}"`;
	try {
		await runSsh(worker, "bash -s", { input: script, timeoutSeconds: 10 });
	} catch {
		// A stale slot is reaped automatically after six hours.
	}
}

function uploadCommand(worker: Worker, repoName: string, jobId: string): string {
	return `${rootAssignment(worker.root)}; JOB="$ROOT/${repoName}/${jobId}"; mkdir -p "$JOB/source"; date +%s > "$JOB/created"; tar -xzf - -C "$JOB/source"`;
}

function testScript(worker: Worker, repoName: string, jobId: string, command: string, keepSource: boolean): string {
	return `
set -o pipefail
${rootAssignment(worker.root)}
JOB="$ROOT/${repoName}/${jobId}"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/share/mise/shims:/opt/homebrew/opt/rustup/bin:/opt/homebrew/opt/openjdk@21/bin:/opt/homebrew/opt/ruby/bin:/opt/homebrew/lib/ruby/gems/4.0.0/bin:/opt/homebrew/opt/python@3.14/libexec/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
if [ -d /opt/homebrew/opt/openjdk@21 ]; then export JAVA_HOME=/opt/homebrew/opt/openjdk@21; fi
if [ -d /opt/homebrew/opt/dotnet/libexec ]; then export DOTNET_ROOT=/opt/homebrew/opt/dotnet/libexec; fi
cd "$JOB/source" || exit 125
START=$(date +%s)
printf '{"state":"running","started":%s}\n' "$START" > "$JOB/status.json"
set +e
( export CI=1; exec nice -n ${worker.nice} bash -c ${shQuote(command)} ) 2>&1 | tee "$JOB/test.log"
CODE=\${PIPESTATUS[0]}
END=$(date +%s)
printf '{"state":"finished","exitCode":%s,"started":%s,"finished":%s,"durationSeconds":%s}\n' "$CODE" "$START" "$END" "$((END-START))" > "$JOB/result.json"
cp "$JOB/result.json" "$JOB/status.json"
${keepSource ? "" : `
# Drop the uploaded tree as soon as the run ends. Diagnostics (test.log,
# result.json, status.json, created) are tiny and stay for the retention window.
# Done here rather than client-side so it still happens if the SSH link drops.
cd "$ROOT" 2>/dev/null || cd /
rm -rf "$JOB/source"
printf '1' > "$JOB/source-reclaimed"
`}
exit "$CODE"
`;
}

function cleanupScript(worker: Worker, repoName: string): string {
	return `
set +e
${rootAssignment(worker.root)}
BASE="$ROOT/${repoName}"
NOW=$(date +%s)
MAX_AGE=${Math.floor(worker.retentionHours * 3600)}
ORPHAN_AGE=${Math.floor(6 * 3600)}
for d in "$BASE"/*; do
  [ -d "$d" ] || continue
  CREATED=$(cat "$d/created" 2>/dev/null || echo "$NOW")
  AGE=$((NOW-CREATED))
  # Whole job directory past its retention window.
  if [ "$AGE" -gt "$MAX_AGE" ]; then rm -rf "$d"; continue; fi
  # A source tree left by a job that was killed before it could self-clean.
  if [ -d "$d/source" ] && [ ! -f "$d/source-reclaimed" ] && [ "$AGE" -gt "$ORPHAN_AGE" ]; then
    rm -rf "$d/source"
    printf '1' > "$d/source-reclaimed"
  fi
done
`;
}

function blockedResult(worker: Worker | undefined, status: WorkerStatus | undefined, extra?: string) {
	const reason = extra || status?.reasons.join("; ") || "no eligible worker is ready";
	return {
		content: [
			{
				type: "text" as const,
				text: `REMOTE TEST BLOCKED${worker ? ` on ${worker.name}` : ""}: ${reason}. Run the test locally or choose another READY worker. Do not immediately retry the blocked worker.`,
			},
		],
		details: { state: "blocked", worker: worker?.name, status, reason },
	};
}

const SnapshotSchema = Type.Object({
	mode: Type.Optional(
		StringEnum(["working-tree", "tracked", "paths"] as const, {
			description: '"working-tree" includes tracked and non-ignored untracked files; "tracked" includes tracked files only; "paths" includes only selected paths.',
		}),
	),
	paths: Type.Optional(Type.Array(Type.String({ description: "Repository-relative file or directory" }), { maxItems: 500 })),
	excludePaths: Type.Optional(
		Type.Array(Type.String({ description: "Repository-relative file or directory to omit" }), { maxItems: 500 }),
	),
	includeIgnored: Type.Optional(
		Type.Boolean({ description: "Include Git-ignored files. Default false; use only when an ignored fixture is explicitly required." }),
	),
});

export default function remoteJobsExtension(pi: ExtensionAPI) {
	registerRemoteSetup(pi);

	pi.registerTool({
		name: "remote_status",
		label: "Remote Status",
		description: "Report live CPU, memory, GPU, disk, model-mode, and job-slot capacity for configured SSH workers.",
		promptSnippet: "Check available remote test/build worker capacity",
		parameters: Type.Object({
			host: Type.Optional(Type.String({ description: "Specific worker name; omit for all workers" })),
		}),
		async execute(_id, params) {
			const config = await loadConfig();
			const enabled = config.workers.filter((worker) => worker.enabled);
			if (enabled.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No remote workers are enabled. Ask the user to run /remote setup to add or enable one." }],
					details: undefined,
				};
			}
			const selected = params.host ? enabled.filter((worker) => worker.name === params.host) : enabled;
			if (params.host && selected.length === 0) throw new Error(`Unknown remote worker: ${params.host}`);
			const statuses = await Promise.all(selected.map(probeWorker));
			return {
				content: [{ type: "text", text: detailedStatuses(statuses) }],
				details: { statuses },
			};
		},
	});

	pi.registerTool({
		name: "remote_test",
		label: "Remote Test",
		description:
			"Snapshot the current local Git working tree (including uncommitted code), transfer the chosen files through SSH, and run a test/build command on a capacity-gated worker. The snapshot can be the full working tree, tracked files only, or explicit repository-relative paths.",
		promptSnippet: "Run tests/builds on a capacity-gated SSH worker using an exact local code snapshot",
		promptGuidelines: [
			"Call remote_test only after relevant edits have completed; never place remote_test before edit/write calls in the same tool batch.",
			"Use remote_test snapshot.mode=paths when only specific files and their manifests/lockfiles are required; otherwise use working-tree so current uncommitted code is tested.",
			"When remote_test reports BLOCKED, use another READY worker or run the command locally instead of immediately retrying that worker.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			host: Type.Optional(Type.String({ description: 'Worker name or "auto". Default: auto.' })),
			command: Type.String({ minLength: 1, maxLength: 8192, description: "Test or build command to run at the snapshot root" }),
			repositoryPath: Type.Optional(
				Type.String({ description: "Local path inside the target Git repository. Default: current working directory." }),
			),
			snapshot: Type.Optional(SnapshotSchema),
			requiresGpu: Type.Optional(Type.Boolean({ description: "Reserve an exclusive GPU job slot. Default false." })),
			timeoutSeconds: Type.Optional(
				Type.Integer({ minimum: 10, maximum: 21600, description: "Remote command timeout. Default 1800 seconds." }),
			),
			keepSource: Type.Optional(
				Type.Boolean({
					description:
						"Keep the uploaded source tree on the worker after the run for debugging. "
						+ "Default false: the tree is deleted on completion and only diagnostics are retained.",
				}),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const config = await loadConfig();
			const requestedHost = params.host ?? "auto";
			const enabledWorkers = config.workers.filter((worker) => worker.enabled);
			if (enabledWorkers.length === 0) {
				throw new Error("No remote workers are enabled. Ask the user to run /remote setup to add or enable one.");
			}
			if (requestedHost !== "auto" && !enabledWorkers.some((worker) => worker.name === requestedHost)) {
				throw new Error(`Unknown remote worker: ${requestedHost}. Available: ${enabledWorkers.map((w) => w.name).join(", ")}`);
			}
			const statuses = await probeWorkers(config);
			let worker = pickWorker(config, statuses, requestedHost, params.requiresGpu ?? false);
			if (!worker) return blockedResult(undefined, undefined, detailedStatuses(statuses));
			let workerStatus = statuses.find((status) => status.name === worker!.name);
			if (!workerStatus || workerStatus.state !== "ready") return blockedResult(worker, workerStatus);

			onUpdate?.({ content: [{ type: "text", text: `Creating selected snapshot for ${worker.name}...` }], details: { state: "snapshotting", worker: worker.name } });
			const snapshot = await createSnapshot(ctx.cwd, params);
			const jobId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
			let reserved = false;
			const started = Date.now();
			try {
				workerStatus = await probeWorker(worker);
				if (workerStatus.state !== "ready") return blockedResult(worker, workerStatus);
				const reservation = await reserveWorker(worker, jobId, params.requiresGpu ?? false);
				if (!reservation.admitted) return blockedResult(worker, workerStatus, reservation.reason);
				reserved = true;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Uploading ${snapshot.files.length} files (${formatSize(snapshot.archiveBytes)}) to ${worker.name}...`,
						},
					],
					details: { state: "uploading", worker: worker.name, jobId, snapshot: snapshot.fingerprint },
				});
				const upload = await runSsh(worker, uploadCommand(worker, snapshot.repoName, jobId), {
					input: { file: snapshot.archivePath },
					timeoutSeconds: Math.max(120, Math.min(900, Math.ceil(snapshot.archiveBytes / 250000) + 60)),
					signal,
				});
				if (upload.code !== 0 || upload.timedOut || upload.aborted) {
					throw new Error(upload.timedOut ? "snapshot upload timed out" : upload.stderr.trim() || `snapshot upload exited ${upload.code}`);
				}
				let streamed = "";
				let lastUpdate = 0;
				const run = await runSsh(worker, "bash -s", {
					input: testScript(worker, snapshot.repoName, jobId, params.command, params.keepSource === true),
					timeoutSeconds: params.timeoutSeconds ?? 1800,
					signal,
					onData: (chunk) => {
						streamed = appendTail(streamed, chunk);
						if (Date.now() - lastUpdate > 500) {
							lastUpdate = Date.now();
							const preview = truncateTail(streamed, { maxLines: 40, maxBytes: 8000 }).content;
							onUpdate?.({
								content: [{ type: "text", text: preview || `Running on ${worker!.name}...` }],
								details: { state: "running", worker: worker!.name, jobId },
							});
						}
					},
				});
				const durationSeconds = Math.round((Date.now() - started) / 100) / 10;
				const combined = [run.stdout, run.stderr].filter(Boolean).join("\n");
				const truncated = truncateTail(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const remoteJob = `${worker.root}/${snapshot.repoName}/${jobId}`;
				const status = run.aborted ? "ABORTED" : run.timedOut ? "TIMED OUT" : run.code === 0 ? "PASSED" : "FAILED";
				let text = [
					`REMOTE TEST ${status}`,
					`Worker: ${worker.name}`,
					`Job: ${remoteJob}`,
					`Snapshot: ${snapshot.fingerprint.slice(0, 16)} (${snapshot.mode}, ${snapshot.files.length} files, ${formatSize(snapshot.archiveBytes)})`,
					`Git: ${snapshot.commit.slice(0, 12)}${snapshot.dirty ? " + working-tree changes" : ""}`,
					`Command: ${params.command}`,
					`Exit code: ${run.code}`,
					`Duration: ${durationSeconds}s`,
					"",
					truncated.content || "(no output)",
				].join("\n");
				if (truncated.truncated || run.totalOutputBytes > DEFAULT_MAX_BYTES) {
					text += `\n\n[Output truncated; full log: ${remoteJob}/test.log]`;
				}
				void runSsh(worker, "bash -s", { input: cleanupScript(worker, snapshot.repoName), timeoutSeconds: 15 }).catch(() => {});
				return {
					content: [{ type: "text", text }],
					details: {
						state: status.toLowerCase().replace(" ", "_"),
						worker: worker.name,
						jobId,
						remoteJob,
						exitCode: run.code,
						durationSeconds,
						timedOut: run.timedOut,
						aborted: run.aborted,
						snapshot: {
							mode: snapshot.mode,
							fingerprint: snapshot.fingerprint,
							commit: snapshot.commit,
							dirty: snapshot.dirty,
							fileCount: snapshot.files.length,
							files: snapshot.files,
						},
					},
				};
			} finally {
				await rm(snapshot.tempDir, { recursive: true, force: true });
				if (reserved) await releaseWorker(worker, jobId);
			}
		},
	});

}
