import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { registerRemoteSetup } from "./setup.ts";
import { Type } from "typebox";
import { appendTail } from "../../core/exec/process.ts";
import { loadConfig } from "./workers.ts";
import { blockedResult, detailedStatuses, pickWorker, probeWorker, probeWorkers } from "./status.ts";
import { createSnapshot } from "./snapshot.ts";
import { cleanupScript, releaseWorker, reserveWorker, testScript, uploadCommand } from "./jobs.ts";
import { runSsh } from "./ssh.ts";

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
