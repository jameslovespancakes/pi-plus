import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractSection, promoteUnreleased } from "../scripts/changelog.mjs";

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- A new thing.

## [1.0.1] - 2026-01-02

### Fixed

- An old thing.

## [1.0.0] - 2026-01-01

First release.

[Unreleased]: https://github.com/x/y/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/x/y/compare/v1.0.0...v1.0.1
`;

test("extracts a version's body without its heading", () => {
  assert.equal(extractSection(SAMPLE, "1.0.1"), "### Fixed\n\n- An old thing.");
});

test("stops at the next version heading", () => {
  assert.ok(!extractSection(SAMPLE, "1.0.1")!.includes("First release"));
});

test("a missing or empty version yields undefined", () => {
  // The release step turns this into a hard failure rather than empty notes.
  assert.equal(extractSection(SAMPLE, "9.9.9"), undefined);
  assert.equal(extractSection("# Changelog\n\n## [2.0.0] - x\n", "2.0.0"), undefined);
});

test("promotion retitles Unreleased and leaves a fresh one", () => {
  const out = promoteUnreleased(SAMPLE, "1.0.2", "2026-03-04");
  assert.match(out, /## \[1\.0\.2\] - 2026-03-04/);
  assert.match(out, /## \[Unreleased\]/, "a new empty Unreleased remains");
  assert.equal(extractSection(out, "1.0.2"), "### Added\n\n- A new thing.");
  assert.equal(extractSection(out, "Unreleased"), undefined, "the new one is empty");
});

test("promotion rewrites the compare links", () => {
  const out = promoteUnreleased(SAMPLE, "1.0.2", "2026-03-04");
  assert.match(out, /\[Unreleased\]: \S+compare\/v1\.0\.2\.\.\.HEAD/);
  assert.match(out, /\[1\.0\.2\]: \S+compare\/v1\.0\.1\.\.\.v1\.0\.2/);
});

test("promoting an empty Unreleased throws", () => {
  // Otherwise a release would ship notes that say nothing.
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - x\n\nold\n";
  assert.throws(() => promoteUnreleased(empty, "1.0.1"), /empty/i);
});

test("a changelog with no Unreleased section throws", () => {
  assert.throws(() => promoteUnreleased("# Changelog\n\n## [1.0.0] - x\n\nold\n", "1.0.1"), /Unreleased/);
});

test("the real CHANGELOG is structurally sound", () => {
  // A rebase once folded new entries into an already-released section,
  // leaving that version with two "### Changed" blocks and an empty
  // Unreleased. Both are silent until a release fails or ships wrong notes.
  const real = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

  const versions = [...real.matchAll(/^##\s+\[([^\]]+)\]/gm)].map((m) => m[1]);
  assert.deepEqual(
    versions.filter((v, i) => versions.indexOf(v) !== i),
    [],
    "each version heading appears exactly once",
  );
  assert.equal(versions[0], "Unreleased", "Unreleased leads the file");

  for (const version of versions) {
    const body = extractSection(real, version);
    if (!body) continue;
    const kinds = [...body.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].trim());
    assert.deepEqual(
      kinds.filter((k, i) => kinds.indexOf(k) !== i),
      [],
      `${version} must not repeat a change kind`,
    );
  }
});

test("every released version has a link reference", () => {
  const real = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  for (const version of [...real.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])) {
    // Plain string search: building this as a regex means escaping the dots
    // and brackets, which is easy to get subtly wrong.
    assert.ok(real.includes(`\n[${version}]: `),
      `${version} needs a link reference at the foot of the file`);
  }
});
