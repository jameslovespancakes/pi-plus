#!/usr/bin/env node
/**
 * Extracts one version's section from CHANGELOG.md, for use as GitHub release
 * notes.
 *
 *   node scripts/changelog.mjs 1.0.2            print that version's notes
 *   node scripts/changelog.mjs --promote 1.0.2  retitle Unreleased as 1.0.2
 *
 * Promotion exists because the release bumps the version automatically, so the
 * next number is not known while the entry is being written. Changes are
 * written under `## [Unreleased]` and retitled at release time.
 *
 * Exits non-zero when there is nothing to release, so a release fails loudly
 * rather than shipping empty notes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function extractSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  // Matches "## [1.0.2] - date" and "## 1.0.2", so the changelog is free to
  // use either link-reference or plain headings.
  const wanted = new RegExp(`^##\\s+\\[?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`);
  const anyHeading = /^##\s+/;

  const start = lines.findIndex((line) => wanted.test(line));
  if (start === -1) return undefined;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => anyHeading.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : undefined;
}

/**
 * Retitles `## [Unreleased]` as the given version, adds a fresh empty
 * Unreleased heading above it, and maintains the compare links at the foot.
 */
export function promoteUnreleased(markdown, version, today = new Date().toISOString().slice(0, 10)) {
  const heading = /^##\s+\[?Unreleased\]?.*$/m;
  const match = markdown.match(heading);
  if (!match) throw new Error("CHANGELOG.md has no ## [Unreleased] section.");

  const body = extractSection(markdown, "Unreleased");
  if (!body) throw new Error("## [Unreleased] is empty; nothing to release.");

  const previous = [...markdown.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)][0]?.[1];

  let out = markdown.replace(heading, `## [Unreleased]

## [${version}] - ${today}`);

  // Keep the link references consistent with the new heading.
  out = out.replace(
    /^\[Unreleased\]:.*$/m,
    `[Unreleased]: https://github.com/jameslovespancakes/pi-plus/compare/v${version}...HEAD`,
  );
  const link = previous
    ? `[${version}]: https://github.com/jameslovespancakes/pi-plus/compare/v${previous}...v${version}`
    : `[${version}]: https://github.com/jameslovespancakes/pi-plus/releases/tag/v${version}`;
  out = out.replace(/^(\[Unreleased\]:.*)$/m, `$1
${link}`);
  return out;
}

function main() {
  const promote = process.argv[2] === "--promote";
  const version = process.argv[promote ? 3 : 2]?.replace(/^v/, "");
  if (!version) {
    console.error("usage: node scripts/changelog.mjs [--promote] <version>");
    process.exit(2);
  }

  const path = join(root, "CHANGELOG.md");
  const markdown = readFileSync(path, "utf8");

  if (promote) {
    try {
      writeFileSync(path, promoteUnreleased(markdown, version));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    process.stdout.write(`${extractSection(readFileSync(path, "utf8"), version)}\n`);
    return;
  }

  const section = extractSection(markdown, version);

  if (!section) {
    console.error(`No CHANGELOG.md section for ${version}. Add one before releasing.`);
    process.exit(1);
  }
  process.stdout.write(section + "\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main();
}
