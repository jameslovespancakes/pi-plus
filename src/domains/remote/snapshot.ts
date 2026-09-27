import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { runLocal, runProcess } from "../../core/exec/process.ts";
import { type SnapshotResult } from "./types.ts";

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

export async function createSnapshot(
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
