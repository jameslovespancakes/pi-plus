import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTarget, readSshHosts } from "../src/core/exec/ssh-config.ts";

function withConfig(contents: string, run: (path: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-plus-ssh-"));
  const path = join(dir, "config");
  writeFileSync(path, contents, "utf8");
  try {
    run(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parses a standard host block", () => {
  withConfig(
    `Host gpu-box
    HostName 203.0.113.9
    User deploy
    Port 2222
    IdentityFile ~/.ssh/gpu_ed25519
`,
    (path) => {
      const [host] = readSshHosts(path);
      assert.equal(host.alias, "gpu-box");
      assert.equal(host.hostName, "203.0.113.9");
      assert.equal(host.user, "deploy");
      assert.equal(host.port, 2222);
      assert.equal(host.identityFile, "~/.ssh/gpu_ed25519");
    },
  );
});

test("wildcard and negated patterns are not offered as hosts", () => {
  withConfig(
    `Host *
    ServerAliveInterval 30

Host real
    HostName real.example

Host prod-?
    HostName pattern.example

Host !banned
    HostName no.example
`,
    (path) => {
      assert.deepEqual(readSshHosts(path).map((h) => h.alias), ["real"]);
    },
  );
});

test("a multi-alias Host line yields the first connectable alias", () => {
  withConfig(
    `Host * shorty longer
    HostName many.example
`,
    (path) => {
      const hosts = readSshHosts(path);
      assert.equal(hosts.length, 1);
      assert.equal(hosts[0].alias, "shorty");
    },
  );
});

test("keywords are case-insensitive and accept '=' separators", () => {
  withConfig(
    `HOST odd
    hostname=odd.example
    USER   root
    PoRt = 2200
`,
    (path) => {
      const [host] = readSshHosts(path);
      assert.equal(host.hostName, "odd.example");
      assert.equal(host.user, "root");
      assert.equal(host.port, 2200);
    },
  );
});

test("comments, blank lines and junk are ignored", () => {
  withConfig(
    `# leading comment

Host good
    # inner comment
    HostName good.example
    ThisIsNotAKeyword
    =garbage=
`,
    (path) => {
      const hosts = readSshHosts(path);
      assert.equal(hosts.length, 1);
      assert.equal(hosts[0].hostName, "good.example");
    },
  );
});

test("Include pulls in additional files", () => {
  withConfig(
    "",
    (path, dir) => {
      mkdirSync(join(dir, "conf.d"), { recursive: true });
      writeFileSync(join(dir, "conf.d", "extra"), "Host included\n    HostName inc.example\n", "utf8");
      writeFileSync(path, `Include conf.d/extra\n\nHost main\n    HostName main.example\n`, "utf8");
      assert.deepEqual(readSshHosts(path).map((h) => h.alias), ["included", "main"]);
    },
  );
});

test("Include globs expand", () => {
  withConfig(
    "",
    (path, dir) => {
      mkdirSync(join(dir, "conf.d"), { recursive: true });
      writeFileSync(join(dir, "conf.d", "a"), "Host alpha\n", "utf8");
      writeFileSync(join(dir, "conf.d", "b"), "Host beta\n", "utf8");
      writeFileSync(path, "Include conf.d/*\n", "utf8");
      assert.deepEqual(readSshHosts(path).map((h) => h.alias).sort(), ["alpha", "beta"]);
    },
  );
});

test("an include cycle terminates", () => {
  withConfig(
    "",
    (path, dir) => {
      const other = join(dir, "other");
      writeFileSync(path, `Include ${other}\nHost first\n`, "utf8");
      writeFileSync(other, `Include ${path}\nHost second\n`, "utf8");
      const hosts = readSshHosts(path).map((h) => h.alias);
      assert.deepEqual(hosts.sort(), ["first", "second"]);
    },
  );
});

test("the first definition of an alias wins, matching ssh", () => {
  withConfig(
    `Host dup
    HostName first.example

Host dup
    HostName second.example
`,
    (path) => {
      const hosts = readSshHosts(path);
      assert.equal(hosts.length, 1);
      assert.equal(hosts[0].hostName, "first.example");
    },
  );
});

test("a missing config file yields no hosts rather than throwing", () => {
  assert.deepEqual(readSshHosts(join(tmpdir(), "definitely-absent-config-xyz")), []);
});

test("only path metadata is captured, never key material", () => {
  withConfig(
    `Host secure
    HostName secure.example
    IdentityFile ~/.ssh/id_ed25519
`,
    (path) => {
      const [host] = readSshHosts(path);
      const serialized = JSON.stringify(host);
      assert.ok(serialized.includes("id_ed25519"), "the path is retained");
      assert.doesNotMatch(serialized, /PRIVATE KEY/, "no key contents anywhere in the record");
      assert.deepEqual(
        Object.keys(host).sort(),
        ["alias", "hostName", "identityFile", "source"].sort(),
      );
    },
  );
});

test("parseTarget handles user, host and port combinations", () => {
  assert.deepEqual(parseTarget("gpu-box"), { user: undefined, host: "gpu-box", port: undefined });
  assert.deepEqual(parseTarget("deploy@1.2.3.4"), { user: "deploy", host: "1.2.3.4", port: undefined });
  assert.deepEqual(parseTarget("deploy@1.2.3.4:2222"), { user: "deploy", host: "1.2.3.4", port: 2222 });
  assert.deepEqual(parseTarget("  spaced@host  "), { user: "spaced", host: "host", port: undefined });
});

test("parseTarget rejects malformed input", () => {
  for (const bad of ["", "   ", "has space@host", "@host", "host:0", "host:99999", "host:abc"]) {
    assert.equal(parseTarget(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("parseTarget leaves IPv6 literals intact", () => {
  assert.deepEqual(parseTarget("user@fe80::1"), { user: "user", host: "fe80::1", port: undefined });
});
