#!/usr/bin/env node
/**
 * Odometer version bump.
 *
 *   patch += 1
 *   patch reaching PATCH_CAP (100) rolls into minor   → 1.2.99  then 1.3.0
 *   minor reaching MINOR_CAP (10)  rolls into major   → 1.9.99  then 2.0.0
 *
 * So versions run 1.0.0 → 1.0.1 → … → 1.0.99 → 1.1.0 → … → 1.9.99 → 2.0.0,
 * giving 1000 releases per major.
 *
 * Usage:
 *   node scripts/bump-version.mjs            # writes package.json, prints new version
 *   node scripts/bump-version.mjs --dry-run  # prints only
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const PATCH_CAP = 100;
export const MINOR_CAP = 10;

export function nextVersion(current) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current).trim());
  if (!match) throw new Error(`Cannot parse version “${current}” (expected MAJOR.MINOR.PATCH)`);

  let [major, minor, patch] = match.slice(1).map(Number);
  patch += 1;

  if (patch >= PATCH_CAP) {
    patch = 0;
    minor += 1;
  }
  if (minor >= MINOR_CAP) {
    minor = 0;
    major += 1;
  }

  return `${major}.${minor}.${patch}`;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, "..", "package.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  const from = manifest.version;
  const to = nextVersion(from);

  if (!process.argv.includes("--dry-run")) {
    // Preserve formatting/trailing newline so the diff stays to one line.
    writeFileSync(manifestPath, raw.replace(`"version": "${from}"`, `"version": "${to}"`), "utf8");
  }

  process.stdout.write(`${to}\n`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `from=${from}\nto=${to}\n`, { flag: "a" });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
