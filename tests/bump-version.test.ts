import test from "node:test";
import assert from "node:assert/strict";
import { MINOR_CAP, PATCH_CAP, nextVersion } from "../scripts/bump-version.mjs";

test("caps are the documented odometer limits", () => {
  assert.equal(PATCH_CAP, 100);
  assert.equal(MINOR_CAP, 10);
});

test("ordinary bumps only move the patch", () => {
  assert.equal(nextVersion("1.0.0"), "1.0.1");
  assert.equal(nextVersion("1.0.1"), "1.0.2");
  assert.equal(nextVersion("1.2.57"), "1.2.58");
});

test("patch rolls into minor at the cap", () => {
  assert.equal(nextVersion("1.0.98"), "1.0.99", "99 is the last patch");
  assert.equal(nextVersion("1.0.99"), "1.1.0");
  assert.equal(nextVersion("1.8.99"), "1.9.0");
});

test("minor rolls into major at the cap", () => {
  assert.equal(nextVersion("1.9.99"), "2.0.0");
  assert.equal(nextVersion("9.9.99"), "10.0.0");
});

test("a full major is exactly 1000 releases", () => {
  let version = "1.0.0";
  let count = 0;
  while (!version.startsWith("2.")) {
    version = nextVersion(version);
    count += 1;
    assert.ok(count <= 2000, "guard against a non-terminating odometer");
  }
  assert.equal(count, 1000);
  assert.equal(version, "2.0.0");
});

test("every version in a major cycle stays within its caps", () => {
  let version = "1.0.0";
  for (let index = 0; index < 1000; index += 1) {
    version = nextVersion(version);
    const [, minor, patch] = version.split(".").map(Number);
    assert.ok(patch < PATCH_CAP, `patch ${patch} exceeded cap`);
    assert.ok(minor < MINOR_CAP, `minor ${minor} exceeded cap`);
  }
});

test("versions increase monotonically under semver comparison", () => {
  const cases = [["1.0.0", "1.0.1"], ["1.0.99", "1.1.0"], ["1.9.99", "2.0.0"]];
  for (const [from, expected] of cases) {
    const to = nextVersion(from);
    assert.equal(to, expected);
    const [a, b] = [from, to].map((v) => v.split(".").map(Number));
    const greater = b[0] !== a[0] ? b[0] > a[0] : b[1] !== a[1] ? b[1] > a[1] : b[2] > a[2];
    assert.ok(greater, `${to} must sort above ${from} or npm will reject it`);
  }
});

test("malformed versions are rejected rather than silently coerced", () => {
  for (const bad of ["1.0", "v1.0.0", "1.0.0-beta", "", "abc"]) {
    assert.throws(() => nextVersion(bad), /Cannot parse version/);
  }
});
