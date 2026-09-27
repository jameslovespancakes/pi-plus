import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { BUILTIN_WORKFLOW_DEFINITIONS } from "../src/domains/workflows/definitions/workflows.ts";

const root = process.cwd();
const normalize = (path: string) => path.replaceAll("\\", "/");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

interface Edge { target: string; runtime: boolean }
const graph = new Map<string, Edge[]>();
for (const file of files("src").filter((path) => path.endsWith(".ts"))) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  function add(specifier: ts.Node | undefined, runtime: boolean): void {
    if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith(".")) return;
    const target = resolve(dirname(file), specifier.text);
    assert.ok(existsSync(target), `${file}: missing ${specifier.text}`);
    edges.push({ target: normalize(relative(root, target)), runtime });
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      add(node.moduleSpecifier, !typesOnly);
    } else if (ts.isExportDeclaration(node)) {
      const names = node.exportClause;
      const typesOnly = node.isTypeOnly || (names && ts.isNamedExports(names)
        && names.elements.length > 0 && names.elements.every((element) => element.isTypeOnly));
      add(node.moduleSpecifier, !typesOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0], true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, false);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  graph.set(normalize(file), edges);
}

test("core, shared provider mechanisms, and providers have one-way dependencies", () => {
  for (const [file, edges] of graph) for (const { target } of edges) {
    if (file.startsWith("src/core/")) assert.ok(target.startsWith("src/core/"), `${file} → ${target}`);
    if (file.startsWith("src/providers/")) assert.ok(!target.startsWith("src/domains/"), `${file} → ${target}`);
    if (file.startsWith("src/providers/shared/")) {
      assert.ok(target.startsWith("src/providers/shared/") || target.startsWith("src/core/"), `${file} → ${target}`);
    }
    if (file.startsWith("src/domains/")) {
      const domain = file.split("/")[2];
      assert.ok(!target.startsWith("src/domains/") || target.split("/")[2] === domain, `${file} → ${target}`);
    }
  }
});

test("the source runtime import graph is acyclic", () => {
  const complete = new Set<string>();
  const active: string[] = [];
  function visit(file: string): void {
    if (complete.has(file)) return;
    assert.ok(!active.includes(file), `Runtime cycle: ${[...active, file].join(" → ")}`);
    active.push(file);
    for (const edge of graph.get(file) ?? []) if (edge.runtime && graph.has(edge.target)) visit(edge.target);
    active.pop();
    complete.add(file);
  }
  for (const file of graph.keys()) visit(file);
});

test("shared terminal renderers do not import provider implementations", () => {
  for (const [file, edges] of graph) if (file.startsWith("src/ui/")) {
    for (const edge of edges) if (edge.runtime) {
      assert.ok(!edge.target.startsWith("src/providers/") && !edge.target.startsWith("src/domains/"), `${file} → ${edge.target}`);
    }
  }
});

test("all declared extensions, built-in source identities and vendored assets exist", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.pi.extensions.length, 7);
  for (const extension of manifest.pi.extensions) assert.ok(existsSync(extension), extension);
  for (const definition of BUILTIN_WORKFLOW_DEFINITIONS) {
    assert.ok(existsSync(definition.path), definition.path);
    assert.ok(normalize(definition.path).includes("/builtins/"));
    assert.ok(existsSync(definition.root), definition.root);
    assert.ok(existsSync(join(definition.root, "core/exec/bounded-process.ts")), "shared execution code stays inside replay provenance");
    assert.ok(existsSync(join(definition.root, "providers/shared/accounts/request-recovery.ts")), "shared recovery stays inside replay provenance");
  }
  for (const file of ["src/providers/anthropic/vendor/xxhash-wasm.js", "src/providers/anthropic/vendor/xxhash-wasm.LICENSE.md",
    "src/providers/anthropic/remote-control/UPSTREAM.md", "src/providers/gemini/LICENSE.md"]) assert.ok(existsSync(file), file);
});

test("removed parallel layouts and mixed-provider endpoint module stay removed", () => {
  for (const path of ["src/core/accounts", "src/core/anthropic", "src/core/codex", "src/core/gemini", "src/services",
    "src/domains/subscriptions/providers", "src/domains/workflows/runtime", "src/providers/usage/usage-source.ts"]) {
    assert.equal(existsSync(path), false, path);
  }
});
