import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * pi installs packages without their peers and hands extensions its own
 * libraries through a fixed set of entry points (the aliases in pi's
 * `core/extensions/loader.js`). Any other import of a pi package — a deep
 * `@earendil-works/pi-ai/...` path — has nothing to resolve against on a
 * clean install, and the extension fails to load for everyone except a
 * developer whose machine happens to have a copy. That shipped once; this
 * keeps it from shipping again.
 */

const PI_SUPPLIED = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
  "typebox",
  "typebox/compile",
  "typebox/value",
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function bareImports(file: string): string[] {
  const code = readFileSync(file, "utf8");
  const specifiers = [...code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((match) => match[1]);
  return specifiers.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"));
}

const packageName = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

test("every import resolves on a clean pi install", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const problems: string[] = [];

  for (const file of sources("src")) {
    for (const specifier of bareImports(file)) {
      if (PI_SUPPLIED.has(specifier)) continue;
      const owner = packageName(specifier);
      if (owner.startsWith("@earendil-works/") || owner === "typebox") {
        problems.push(`${file}: "${specifier}" is not an entry point pi supplies to extensions`);
      } else if (!dependencies.has(owner)) {
        problems.push(`${file}: "${specifier}" is not a declared dependency`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("pi packages are peers with the range pi's packaging docs require", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    assert.equal(manifest.peerDependencies[name], "*", name);
    assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be bundled`);
  }
});
