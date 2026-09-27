import { rootAssignment } from "../../core/exec/process.ts";
import { type Config, type Worker, type WorkerStatus } from "./types.ts";
import { runSsh } from "./ssh.ts";

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

export async function probeWorker(worker: Worker): Promise<WorkerStatus> {
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

export async function probeWorkers(config: Config): Promise<WorkerStatus[]> {
	const active = config.workers.filter((worker) => worker.enabled);
	return Promise.all(active.map(probeWorker));
}

function metric(value: number | undefined): string {
	return value === undefined ? "?" : `${Math.round(value)}%`;
}

export function detailedStatuses(statuses: WorkerStatus[]): string {
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

function gpuCapable(worker: Worker): boolean {
	return worker.tags.some((tag) => ["gpu", "cuda", "metal"].includes(tag.toLowerCase()));
}

export function pickWorker(config: Config, statuses: WorkerStatus[], requested: string, requiresGpu: boolean): Worker | undefined {
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

export function blockedResult(worker: Worker | undefined, status: WorkerStatus | undefined, extra?: string) {
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
