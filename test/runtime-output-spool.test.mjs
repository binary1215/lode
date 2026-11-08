import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { openRuntimeOutputSpool, readRuntimeOutputSpool } from "../scripts/lib/runtime-output-spool.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "head-spool-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authorization = {
    projectId: `head-${"a".repeat(20)}`,
    authorizationId: `execution-authorization-${"b".repeat(24)}`,
    authorizationHash: hash("synthetic authorization"),
    executionInput: { digest: hash("synthetic input") },
    limits: { maxStdoutBytes: 1024, maxStderrBytes: 128 },
  };
  const options = {
    operationalRoot: root,
    authorization,
    callerFenceDigest: hash("synthetic caller"),
    supervisorManifestDigest: hash("synthetic supervisor"),
    providerMode: "codex-protocol-fixture",
  };
  return { options, directory: path.join(root, "runtime-output", authorization.projectId, authorization.authorizationId) };
}

test("provider bytes survive before terminal and are never inferred complete", (t) => {
  const { options } = fixture(t);
  const spool = openRuntimeOutputSpool(options);
  try {
    spool.append("stdout", Buffer.from('{"type":"partial"}\n'));
    spool.append("stderr", Buffer.from("synthetic diagnostic"));
    const observed = readRuntimeOutputSpool(options);
    assert.equal(observed.status, "incomplete");
    assert.equal(observed.outputs.stdout.toString(), '{"type":"partial"}\n');
    assert.equal(observed.recoveryAuthority, false);
  } finally {
    spool.close();
  }
  assert.equal(readRuntimeOutputSpool(options).status, "incomplete");
});

test("replacement reader retains fsynced bytes after writer exits without a terminal", (t) => {
  const { options } = fixture(t);
  const script = `
    import { openRuntimeOutputSpool } from ${JSON.stringify(new URL("../scripts/lib/runtime-output-spool.mjs", import.meta.url).href)};
    process.stdout.write(JSON.stringify({ pid: process.pid, parentPid: process.ppid, cwd: process.cwd(), ports: [] }) + '\\n');
    const spool = openRuntimeOutputSpool(JSON.parse(process.argv[1]));
    spool.append('stdout', Buffer.from('durable partial provider event\\n'));
    process.exit(19); // No complete(), no finally, no explicit close().
  `;
  t.diagnostic(
    JSON.stringify({
      event: "planned",
      command: process.execPath,
      args: ["--input-type=module", "--eval", "synthetic spool writer"],
      parentPid: process.pid,
      cwd: options.operationalRoot,
      ports: [],
    }),
  );
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(options)], {
    cwd: options.operationalRoot,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  t.diagnostic(JSON.stringify({ event: "closed", pid: child.pid, exitCode: child.status, ownership: child.stdout?.trim(), error: child.error?.code }));
  assert.ifError(child.error);
  assert.equal(child.status, 19, child.stderr);
  const observed = readRuntimeOutputSpool(options);
  assert.equal(observed.status, "incomplete");
  assert.equal(observed.outputs.stdout.toString(), "durable partial provider event\n");
  assert.equal(observed.terminal, null);
  assert.equal(observed.recoveryAuthority, false);
  assert.throws(() => openRuntimeOutputSpool(options), { code: "EEXIST" });
});

test("terminal binds durable outputs and remains evidence rather than owner-exit proof", (t) => {
  const { options } = fixture(t);
  const spool = openRuntimeOutputSpool(options);
  const result = { fixtureOnly: true, outcome: "not an actual provider result" };
  try {
    spool.append("stdout", Buffer.from("selected output"));
    spool.complete(result);
  } finally {
    spool.close();
  }
  const observed = readRuntimeOutputSpool(options);
  assert.equal(observed.status, "terminal-recorded");
  assert.equal(observed.terminal.ownerExitRequired, true);
  assert.deepEqual(observed.terminal.result, result);
  assert.throws(() => openRuntimeOutputSpool(options), { code: "EEXIST" });
  assert.throws(() => readRuntimeOutputSpool({ ...options, authorization: { ...options.authorization, authorizationHash: hash("other") } }), {
    code: "INVALID_RUNTIME_OUTPUT_SPOOL",
  });
});

test("overflow stores at most the authorized bytes and discloses truncation", (t) => {
  const { options } = fixture(t);
  const spool = openRuntimeOutputSpool(options);
  try {
    assert.equal(spool.append("stdout", Buffer.alloc(2048, 65)), false);
    spool.complete({ fixtureOnly: true, status: "output-limited" });
  } finally {
    spool.close();
  }
  const observed = readRuntimeOutputSpool(options);
  assert.equal(observed.outputs.stdout.length, 1024);
  assert.equal(observed.terminal.streams.stdout.truncated, true);
});

test("terminal output tamper and hardlinked spool paths are rejected", (t) => {
  const { options, directory } = fixture(t);
  const spool = openRuntimeOutputSpool(options);
  try {
    spool.append("stdout", Buffer.from("original"));
    spool.complete({ fixtureOnly: true });
  } finally {
    spool.close();
  }
  const file = path.join(directory, "stdout.bin");
  fs.writeFileSync(file, "modified");
  assert.throws(() => readRuntimeOutputSpool(options), { code: "INVALID_RUNTIME_OUTPUT_SPOOL" });
  fs.writeFileSync(file, "original");
  fs.linkSync(file, path.join(directory, "alias.bin"));
  assert.throws(() => readRuntimeOutputSpool(options), { code: "INVALID_RUNTIME_OUTPUT_SPOOL" });
});

test("a deleted empty output is not reconstructed as verified terminal evidence", (t) => {
  const { options, directory } = fixture(t);
  const spool = openRuntimeOutputSpool(options);
  try {
    spool.complete({ fixtureOnly: true });
  } finally {
    spool.close();
  }
  assert.equal(readRuntimeOutputSpool(options).status, "terminal-recorded");
  fs.unlinkSync(path.join(directory, "stderr.bin"));
  assert.throws(() => readRuntimeOutputSpool(options), { code: "INVALID_RUNTIME_OUTPUT_SPOOL" });
});

for (const name of ["header", "terminal"]) {
  test(`${name} committed publication remains readable after pending unlink fails`, (t) => {
    const { options, directory } = fixture(t);
    const unlink = fs.unlinkSync;
    let spool;
    if (name === "terminal") {
      spool = openRuntimeOutputSpool(options);
      spool.append("stdout", Buffer.from("complete bytes"));
    }
    fs.unlinkSync = (file) => {
      if (String(file) === path.join(directory, `${name}.json.pending`)) throw Object.assign(new Error("Synthetic publication crash"), { code: "EIO" });
      return unlink(file);
    };
    try {
      assert.throws(() => (name === "header" ? openRuntimeOutputSpool(options) : spool.complete({ fixtureOnly: true })), { code: "EIO" });
    } finally {
      fs.unlinkSync = unlink;
      spool?.close();
    }
    const published = path.join(directory, `${name}.json`);
    assert.equal(fs.statSync(published).nlink, 2);
    const observed = readRuntimeOutputSpool(options);
    assert.equal(observed.status, name === "header" ? "incomplete" : "terminal-recorded");
    assert.equal(fs.statSync(published).nlink, 2, "read did not clean or race the writer");
    fs.linkSync(published, path.join(directory, "unexpected-alias.json"));
    assert.throws(() => readRuntimeOutputSpool(options), { code: "INVALID_RUNTIME_OUTPUT_SPOOL" });
  });
  test(`${name} interrupted before publication never becomes a terminal result`, (t) => {
    const { options, directory } = fixture(t);
    let spool;
    if (name === "terminal") spool = openRuntimeOutputSpool(options);
    const link = fs.linkSync;
    fs.linkSync = (source, destination) => {
      if (String(destination) === path.join(directory, `${name}.json`)) throw Object.assign(new Error("Synthetic before-publication crash"), { code: "EIO" });
      return link(source, destination);
    };
    try {
      assert.throws(() => (name === "header" ? openRuntimeOutputSpool(options) : spool.complete({ fixtureOnly: true })), { code: "EIO" });
    } finally {
      fs.linkSync = link;
      spool?.close();
    }
    assert.equal(readRuntimeOutputSpool(options).status, name === "header" ? "unpublished" : "incomplete");
  });
}
