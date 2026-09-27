import { shQuote, rootAssignment } from "../../core/exec/process.ts";
import { type Worker } from "./types.ts";
import { runSsh } from "./ssh.ts";

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

export async function reserveWorker(worker: Worker, jobId: string, requiresGpu: boolean): Promise<{ admitted: boolean; reason?: string }> {
	const result = await runSsh(worker, "bash -s", { input: reserveScript(worker, jobId, requiresGpu), timeoutSeconds: 15 });
	if (result.code !== 0) return { admitted: false, reason: result.stderr.trim() || `slot reservation exited ${result.code}` };
	const admitted = /(^|\n)ADMITTED=1(\n|$)/.test(result.stdout);
	const reason = result.stdout.match(/(?:^|\n)REASON=([^\n]+)/)?.[1];
	return { admitted, reason };
}

export async function releaseWorker(worker: Worker, jobId: string): Promise<void> {
	const script = `${rootAssignment(worker.root)}\nrm -rf "$ROOT/.slots/${jobId}"`;
	try {
		await runSsh(worker, "bash -s", { input: script, timeoutSeconds: 10 });
	} catch {
		// A stale slot is reaped automatically after six hours.
	}
}

export function uploadCommand(worker: Worker, repoName: string, jobId: string): string {
	return `${rootAssignment(worker.root)}; JOB="$ROOT/${repoName}/${jobId}"; mkdir -p "$JOB/source"; date +%s > "$JOB/created"; tar -xzf - -C "$JOB/source"`;
}

export function testScript(worker: Worker, repoName: string, jobId: string, command: string, keepSource: boolean): string {
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

export function cleanupScript(worker: Worker, repoName: string): string {
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
