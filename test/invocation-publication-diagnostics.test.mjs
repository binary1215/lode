import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import { createFixturePublicationDiagnostics } from "./helpers/invocation-publication-diagnostics.mjs";

console.log(JSON.stringify({ event: "owned-invocation-diagnostics-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

const selectedWorker = [{ path: "synthetic.txt", after: "synthetic change\n" }];

for (const [lockChild, shareDelete, releaseFirst] of [[false, false, false], [false, true, false], [true, false, false], [true, true, false], [true, true, true]])
test(`real Windows staging ${lockChild ? "child" : "directory"} handle share-delete=${shareDelete} release-first=${releaseFirst} isolates publication rename denial`, { skip: process.platform !== "win32" }, async t => {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const control = fs.mkdtempSync(path.join(parent, "head-publication-lock-"));
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "helpers/publication-directory-handle.ps1"),
    "-FixtureDirectory", control, ...(shareDelete ? ["-ShareDelete"] : []), ...(lockChild ? ["-LockChild"] : [])];
  t.diagnostic(JSON.stringify({ event: "lock-helper-planned", command: "powershell.exe", args, parentPid: process.pid, cwd: control, ports: [] }));
  const helper = spawn("powershell.exe", args, { cwd: control, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.diagnostic(JSON.stringify({ event: "lock-helper-started", pid: helper.pid, parentPid: process.pid, command: "powershell.exe", cwd: control, ports: [] }));
  let output = "", exited = false;
  helper.stdout.on("data", chunk => output += chunk); helper.stderr.on("data", chunk => output += chunk);
  const closed = new Promise((resolve, reject) => { helper.once("error", reject); helper.once("close", code => { exited = true; resolve(code); }); });
  closed.catch(() => {});
  t.after(async () => {
    fs.writeFileSync(path.join(control, "release"), "release");
    if (!exited) await Promise.race([closed, delay(1000)]);
    if (!exited) helper.kill(); // Exact test-owned helper only, after graceful release.
    const code = await closed;
    if (code !== 0) t.diagnostic(JSON.stringify({ event: "lock-helper-error", code, output }));
    assert.throws(() => process.kill(helper.pid, 0), { code: "ESRCH" });
    t.diagnostic(JSON.stringify({ event: "lock-helper-closed", pid: helper.pid, parentPid: process.pid, ports: [] }));
    assert.equal(path.dirname(control), parent); fs.rmSync(control, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(control, "ready")) && !exited && Date.now() < deadline) await delay(20);
  assert.ok(fs.existsSync(path.join(control, "ready")), output);
  const waitSync = name => {
    const until = Date.now() + 5000;
    while (!fs.existsSync(path.join(control, name)) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    assert.ok(fs.existsSync(path.join(control, name)), `helper did not publish ${name}`);
  };
  const rename = fs.renameSync, diagnostics = [];
  let attempts = 0, originalError, staging;
  t.mock.method(fs, "renameSync", function (source, target) {
    if (!/\.execution-authorization-[a-f0-9]{24}\.[a-f0-9-]{36}\.tmp$/.test(source)) return Reflect.apply(rename, this, arguments);
    attempts++; staging = source;
    const fixtureParent = source.slice(0, source.indexOf(`${path.sep}project${path.sep}`));
    fs.writeFileSync(path.join(control, "request.json"), JSON.stringify({ directory: source, fixtureParent }), { flag: "wx" });
    waitSync("locked");
    if (releaseFirst) { fs.writeFileSync(path.join(control, "release"), "release"); waitSync("released"); }
    try { return Reflect.apply(rename, this, arguments); }
    catch (cause) { originalError = cause; throw cause; }
    finally { fs.writeFileSync(path.join(control, "release"), "release"); waitSync("released"); }
  });
  const operation = workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(JSON.parse(value)) });
  if (releaseFirst || shareDelete && !lockChild) {
    const result = await operation; assert.equal(result.records.length, 1); assert.equal(diagnostics.length, 0);
  } else {
    await assert.rejects(operation, error => error === originalError && error.code === (lockChild ? "EPERM" : "EBUSY") && error.syscall === "rename");
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].paths.destination.exists, false);
    assert.equal(diagnostics[0].paths.temporary.exists, true);
  }
  assert.equal(attempts, 1); assert.equal(fs.existsSync(staging), false);
  assert.equal(await closed, 0, output);
  t.diagnostic(JSON.stringify({ event: "real-directory-handle-result", lockChild, shareDelete, releaseFirst, renameAttempts: attempts,
    renameErrorCode: originalError?.code ?? null, historicalCauseProven: false, actualProviderInvoked: false }));
});
function injectPublicationFailure(t, { beforeThrow, error = Object.assign(new Error("private-error-text-must-not-be-logged"), { code: "EPERM", syscall: "rename", errno: -4048 }) } = {}) {
  const original = fs.renameSync;
  const observed = { calls: 0, original, error };
  observed.mock = t.mock.method(fs, "renameSync", function (source, destination) {
    if (typeof source !== "string" || !/\.execution-authorization-[a-f0-9]{24}\.[a-f0-9-]{36}\.tmp$/.test(source)) {
      return Reflect.apply(original, this, arguments);
    }
    observed.calls += 1; observed.source = source; observed.destination = destination;
    beforeThrow?.(source, destination);
    throw error;
  });
  return observed;
}

test("fixture publication success stays silent and restores the exact rename function", async t => {
  const original = fs.renameSync, diagnostics = [];
  const f = await workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) });
  assert.equal(f.records.length, 1);
  assert.equal(fs.renameSync, original);
  assert.deepEqual(diagnostics, []);
});

test("publication EPERM captures staging metadata before cleanup and rethrows the identical error once", async t => {
  const fault = injectPublicationFailure(t), diagnostics = [];
  const keys = Object.keys(fault.error);
  await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  assert.equal(fault.calls, 1, "no retry of the publisher");
  assert.equal(fs.renameSync, fault.mock, "the caller's previous mock/function is restored");
  assert.deepEqual(Object.keys(fault.error), keys, "the original error is not decorated or replaced");
  assert.equal(fs.existsSync(fault.source), false, "Core's original finally still cleans staging");
  assert.equal(fs.existsSync(fault.destination), false);
  assert.equal(diagnostics.length, 1);
  const info = JSON.parse(diagnostics[0]);
  assert.equal(info.event, "test-fixture-invocation-publication-failure");
  assert.equal(info.error.code, "EPERM");
  assert.equal(info.operation.renameAttempts, 1);
  assert.equal(info.paths.temporary.exists, true);
  assert.equal(info.paths.temporary.type, "directory");
  assert.ok(info.paths.temporary.entries.some(entry => entry.name === "draft.json"));
  assert.ok(info.paths.temporary.entries.some(entry => entry.name === "receipt.json"));
  assert.equal(info.paths.destination.exists, false);
  assert.equal(info.paths.parent.type, "directory");
  assert.match(info.paths.parent.identity.mode, /^[0-7]+$/);
  assert.equal(info.paths.parent.access.read, "allowed");
  assert.equal(info.process.pid, process.pid);
  assert.equal(info.process.externalProcessesInspected, false);
  assert.equal(info.concurrency.activePublicationCount, 1);
  assert.equal(info.concurrency.sameTargetPublicationCount, 1);
  assert.equal(info.concurrency.externalWriters, "not-observed");
  assert.ok(Date.parse(info.observedAt) >= Date.parse(info.operation.startedAt));
  assert.ok(info.operation.elapsedMs >= 0);
  assert.ok(!diagnostics[0].includes("private-error-text"));
  assert.ok(!diagnostics[0].includes(fault.source));
  assert.ok(Buffer.byteLength(diagnostics[0]) <= 24 * 1024);
});

test("diagnostic sink failure cannot replace the publication error or prevent wrapper cleanup", async t => {
  const fault = injectPublicationFailure(t);
  let diagnostics = 0;
  await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: () => {
    diagnostics += 1; throw new Error("synthetic diagnostic sink unavailable");
  } }))), error => error === fault.error);
  assert.equal(diagnostics, 1);
  assert.equal(fault.calls, 1);
  assert.equal(fs.renameSync, fault.mock);
  assert.equal(fs.existsSync(fault.source), false);
});

test("metadata failures are disclosed and do not mask or retry the original error", async t => {
  const lstat = fs.lstatSync;
  let failing = false;
  t.mock.method(fs, "lstatSync", function (file) {
    if (failing && typeof file === "string" && path.basename(file).startsWith("head-worker-integration-")) {
      throw Object.assign(new Error("do not print a private OS message"), { code: "EACCES" });
    }
    return Reflect.apply(lstat, this, arguments);
  });
  const fault = injectPublicationFailure(t, { beforeThrow: () => { failing = true; } }), diagnostics = [];
  try {
    await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  } finally { failing = false; }
  const info = JSON.parse(diagnostics[0]);
  assert.deepEqual(Object.values(info.paths).map(item => item.errorCode), ["EACCES", "EACCES", "EACCES"]);
  assert.ok(Object.values(info.paths).every(item => item.exists === null));
  assert.equal(fault.calls, 1);
  assert.equal(fs.renameSync, fault.mock);
});

test("diagnostics bound entries and omit unrelated names, contents, commands and absolute paths", async t => {
  const marker = "private-synthetic-canary";
  const fault = injectPublicationFailure(t, { beforeThrow: source => {
    for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(source, `${marker}-${index}`), marker);
  } }), diagnostics = [];
  await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  const info = JSON.parse(diagnostics[0]);
  assert.equal(info.paths.temporary.entries.length, 16);
  assert.equal(info.paths.temporary.entriesTruncated, true);
  assert.ok(!diagnostics[0].includes(marker));
  assert.ok(!diagnostics[0].includes(process.execPath));
  assert.ok(!diagnostics[0].includes(process.cwd()));
  assert.ok(Buffer.byteLength(diagnostics[0]) <= 24 * 1024);
  assert.equal(fs.existsSync(fault.source), false);
});

test("changed fixture root identity prevents further diagnostic traversal", async t => {
  const lstat = fs.lstatSync;
  let failing = false;
  t.mock.method(fs, "lstatSync", function (file, options) {
    const stat = Reflect.apply(lstat, this, arguments);
    if (failing && options?.bigint && path.basename(file).startsWith("head-worker-integration-")) {
      return Object.assign(Object.create(stat), { ino: stat.ino + 1n });
    }
    return stat;
  });
  const fault = injectPublicationFailure(t, { beforeThrow: () => { failing = true; } }), diagnostics = [];
  try {
    await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  } finally { failing = false; }
  const info = JSON.parse(diagnostics[0]);
  assert.ok(Object.values(info.paths).every(item => item.inspection === "fixture-root-changed-not-inspected"));
  assert.ok(Object.values(info.paths).every(item => item.entries === undefined && item.access === undefined));
  assert.equal(fs.renameSync, fault.mock);
});

test("an observed link ancestor blocks diagnostic child inspection", async t => {
  const lstat = fs.lstatSync;
  let replacedAncestor;
  t.mock.method(fs, "lstatSync", function (file, options) {
    const stat = Reflect.apply(lstat, this, arguments);
    // Synthetic metadata substitution, not a claim of an atomic race test.
    if (file === replacedAncestor && options?.bigint) return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
    return stat;
  });
  const fault = injectPublicationFailure(t, { beforeThrow: source => { replacedAncestor = path.dirname(source); } }), diagnostics = [];
  try {
    await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  } finally { replacedAncestor = undefined; }
  const info = JSON.parse(diagnostics[0]);
  assert.equal(info.paths.temporary.inspection, "ancestor-not-plain-directory");
  assert.equal(info.paths.destination.inspection, "ancestor-not-plain-directory");
  assert.equal(info.paths.parent.inspection, "link-target-not-inspected");
  assert.ok(Object.values(info.paths).every(item => item.entries === undefined && item.access === undefined));
});

test("destination links are observed without reading the external synthetic target", async t => {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const outside = fs.mkdtempSync(path.join(parent, "head-diagnostic-outside-"));
  t.after(() => { assert.equal(path.dirname(outside), parent); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, "private-target-canary"), "never read");
  const openDirectory = fs.opendirSync;
  let externalReads = 0;
  t.mock.method(fs, "opendirSync", function (file) {
    if (fs.realpathSync(file) === outside) { externalReads += 1; throw new Error("external synthetic target must not be inspected"); }
    return Reflect.apply(openDirectory, this, arguments);
  });
  const fault = injectPublicationFailure(t, { beforeThrow: (_source, destination) => fs.symlinkSync(outside, destination, process.platform === "win32" ? "junction" : "dir") });
  const diagnostics = [];
  await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  const info = JSON.parse(diagnostics[0]);
  assert.equal(info.paths.destination.type, "symbolic-link");
  assert.equal(info.paths.destination.inspection, "link-target-not-inspected");
  assert.equal(info.paths.destination.access, undefined);
  assert.equal(externalReads, 0);
  assert.ok(!diagnostics[0].includes(outside));
  assert.ok(!diagnostics[0].includes("private-target-canary"));
});

test("only registered synthetic fixture work is reported, never fabricated cross-process ownership", async t => {
  const first = await workerIntegrationFixture(t, { workers: selectedWorker });
  const fault = injectPublicationFailure(t), diagnostics = [];
  await assert.rejects(((workerIntegrationFixture(t, { workers: selectedWorker, publicationDiagnosticSink: value => diagnostics.push(value) }))), error => error === fault.error);
  const info = JSON.parse(diagnostics[0]);
  assert.equal(info.concurrency.activeFixtureCount, 2);
  assert.equal(info.concurrency.activePublicationCount, 1);
  assert.equal(new Set(info.concurrency.fixtures.map(item => item.fixtureId)).size, 2);
  assert.equal(info.concurrency.publications[0].workerIndex, 0);
  assert.equal(fs.existsSync(first.root), true);
});

test("test diagnostics refuse unrelated project roots before collecting or publishing", t => {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-worker-integration-"));
  const diagnostics = createFixturePublicationDiagnostics(container);
  t.after(() => { diagnostics.close(); assert.equal(path.dirname(container), parent); fs.rmSync(container, { recursive: true, force: true }); });
  assert.throws(() => diagnostics.publish({ projectRoot: parent, authorization: { authorizationId: `execution-authorization-${"a".repeat(24)}` } }), /exact project/);
});
