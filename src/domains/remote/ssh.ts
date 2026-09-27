import { resolve } from "node:path";
import { homedir } from "node:os";
import { runSshCommand, type ProcessResult, type RunOptions } from "../../core/exec/process.ts";
import { type Worker } from "./types.ts";

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

export async function runSsh(
	worker: Worker,
	remoteCommand: string,
	options: RunOptions = {},
): Promise<ProcessResult> {
	return runSshCommand(worker.ssh, remoteCommand, options, sshArgsFor(worker));
}
