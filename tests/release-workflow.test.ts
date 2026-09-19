import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const release = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");

test("release publishing requires an explicit release flag", () => {
  assert.match(release, /contains\(github\.event\.head_commit\.message, '--release'\)/);
  assert.match(release, /github\.event_name == 'workflow_dispatch' && inputs\.release == '--release'/);
  assert.doesNotMatch(release, /contains\([^\n]+\[release\]/);
});

test("release notes collect and push changes since the prior tag", () => {
  assert.match(release, /git describe --tags --abbrev=0 HEAD/);
  assert.match(release, /"\$PREVIOUS_TAG\.\.HEAD"/);
  assert.match(release, /git push origin HEAD:main/);
  assert.match(release, /git push origin "v\$VERSION"/);
});
